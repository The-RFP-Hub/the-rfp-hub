/**
 * The verifier will not be pointed at the inside of the network.
 *
 * WHY THIS FILE BOOTS ITS OWN API. The long-lived instance the rest of the suite drives runs with
 * `VERIFY_ALLOW_PRIVATE_HOSTS=true`, and it has to: the fixture web server every verification test
 * fetches is itself on 127.0.0.1, so with the flag off no verification criterion could run at all.
 * That same flag is what these assertions are about. So this file starts a SHORT-LIVED second API
 * with the flag absent, makes its refusals, and shuts it down — the alternative, a second long-lived
 * process, would double the run's resource footprint for a handful of assertions.
 *
 * THE REFUSAL IS THE ASSERTION. Each target below is an address the verifier must decline before it
 * makes any request at all, so nothing needs to be listening at the other end: if a request were
 * made, the address check did not happen, which is the failure. No fixture server is involved.
 *
 * TWO CASES ARE NOT HERE, on purpose. A redirect from a public first hop to a private second hop,
 * and DNS rebinding between the two, cannot be produced from outside the process — the first hop has
 * to resolve publicly and the second privately, within one fetch. Those live at the integration
 * layer (`packages/api/test/integration/verification.test.ts`), against the REAL fetcher with only
 * the first hop injected, and the report records them at that layer rather than claiming them here.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiDir, apiEnv } from "../src/env.js";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";
import { ApiClient, isHealthy } from "../src/http.js";
import { outboxFileFor } from "../src/identity/outbox.js";
import { AUTH_SECRET_ENV, sessionFor } from "../src/identity/sessions.js";
import * as orphans from "../src/orphans.js";
import * as ports from "../src/ports.js";
import * as processes from "../src/processes.js";

/**
 * Every address family the classifier has to recognise, and why each one is on the list.
 *
 * The two IPv6 forms matter most: a check written against dotted-quad strings alone passes for
 * `169.254.169.254` and waves through `[::ffff:169.254.169.254]`, which reaches the same host.
 */
const PRIVATE_TARGETS: Array<[string, string]> = [
  ["loopback", "http://127.0.0.1:1/"],
  ["private range", "http://10.0.0.1/"],
  ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
  ["IPv6 loopback", "http://[::1]:1/"],
  ["IPv6-mapped metadata", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
];

test.describe("SSRF: direct private targets are refused", () => {
  test.describe.configure({ mode: "serial" });

  let api: processes.ManagedChild | undefined;
  let baseUrl = "";

  test.beforeAll(async ({ stack }) => {
    // Nothing to boot when the assertions below cannot run: a second API process is expensive, and
    // starting one for a suite that is about to skip is pure cost.
    if (!stack.actors.publisher || !stack.actors.reviewer) return;

    const port = await ports.reserve(new Set(Object.values(stack.ports)));
    baseUrl = `http://127.0.0.1:${port}`;
    api = processes.start({
      name: "api-ssrf",
      command: "pnpm",
      args: ["exec", "tsx", "src/server.ts"],
      cwd: apiDir,
      env: apiEnv({
        databaseUrl: stack.db.runtimeUrl,
        port,
        // Its own signing secret: sessions minted against the main instance are not valid here, so
        // this instance signs in its own reviewer below rather than borrowing a token.
        // THE SAME SECRET as the main instance, because this one shares its database. A session is
        // a row plus an HMAC over it; a second instance signing with a different secret would refuse
        // every token this run already holds, and each refusal below would be an authentication
        // failure rather than the address check it claims to be.
        authSecret: process.env[AUTH_SECRET_ENV] ?? "",
        outboxDir: stack.outboxDir,
        dashboardOrigin: stack.urls.dashboard,
        analyticsHmacKey: randomBytes(32).toString("hex"),
        // The whole point of this instance: the address checks are ON.
        allowPrivateHosts: false,
      }),
      logFile: join(process.env.E2E_TMP_DIR ?? ".", "logs", "api-ssrf.log"),
    });
    // Registered with the RUNNER before anything is awaited. `afterAll` stops this process in the
    // normal case, but `afterAll` is exactly what does not run when a worker is killed or crashes —
    // and an API server that outlives its run holds a port and a database connection that the next
    // run knows nothing about. The runner's own teardown reaps anything left here.
    orphans.register(api.pid, "ssrf.spec.ts flag-off API");
    await processes.waitFor({
      what: "the flag-off API",
      watch: api,
      timeoutMs: 90_000,
      probe: () => isHealthy(baseUrl),
    });
  });

  test.afterAll(async () => {
    if (api) await processes.stop(api);
  });

  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("every private address family is declined before a request is made", async ({
    stack,
    api: apiFor,
    opportunityFixture,
  }) => {
    const publisher = await apiFor("publisher");
    const reviewer = stack.actors.reviewer;
    if (!reviewer) throw new Error("no reviewer identity");

    // The entries are created through the MAIN instance and verified through the flag-off one: both
    // processes share this run's database, so the same row is reachable from either.
    const guarded = new ApiClient({ baseUrl, token: (await sessionFor(reviewer.email)).token });

    for (const [label, applicationUrl] of PRIVATE_TARGETS) {
      const document = opportunityFixture(
        stack.namespaces.publisher,
        `ssrf-${label.replace(/\W+/g, "")}-${Date.now()}`,
        { applicationUrl },
      );
      expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

      const run = await guarded.post<{
        existsAtSource: boolean;
        httpStatus: number | null;
        error: string | null;
      }>(
        `/v1/review/opportunities/${encodeURIComponent(document.id as string)}/verify`,
        undefined,
        {
          timeoutMs: 30_000,
        },
      );

      expect(run.status, `${label}: the run itself is recorded`).toBe(200);
      expect(run.body.existsAtSource, `${label} must not be treated as a live page`).toBe(false);
      // No status at all: the address was refused, so no HTTP exchange ever happened. A recorded
      // status here would mean the request WAS made and only the result was discarded.
      expect(run.body.httpStatus, `${label}: no request may have been made`).toBeNull();
      expect(run.body.error ?? "", `${label} must be refused on the address`).toMatch(
        /address_refused/,
      );
    }
  });
});

/**
 * A deployment that cannot deliver a code cannot sign anybody in — and says so.
 *
 * THIS REPLACES A CASE THAT USED TO EXIST FOR A DIFFERENT REASON. The suite once reached
 * `auth_unconfigured` by booting an API with no identity-provider key: the verifier had nothing to
 * verify against and answered 503. There is no verifier key any more, so that path is gone — but the
 * property it stood for is not. A deployment whose codes go nowhere is not degraded, it is a locked
 * door: every sign-in would stall at "enter the code" with nothing wrong anywhere a person could
 * see, which is precisely the failure that must be loud instead of silent.
 *
 * `EMAIL_TRANSPORT=null` is that deployment. It boots — the transport is a valid configuration, and
 * `config.ts` refuses it only under `NODE_ENV=production` — and the sign-in surface reports itself
 * unavailable rather than pretending to have sent something.
 */
test.describe("an API that cannot deliver a code refuses to start a sign-in", () => {
  let unconfigured: processes.ManagedChild | undefined;
  let unconfiguredUrl = "";

  test.beforeAll(async ({ stack }) => {
    const port = await ports.reserve(new Set(Object.values(stack.ports)));
    unconfiguredUrl = `http://127.0.0.1:${port}`;
    unconfigured = processes.start({
      name: "api-no-email",
      command: "pnpm",
      args: ["exec", "tsx", "src/server.ts"],
      cwd: apiDir,
      env: apiEnv({
        databaseUrl: stack.db.runtimeUrl,
        port,
        authSecret: process.env[AUTH_SECRET_ENV] ?? "",
        outboxDir: stack.outboxDir,
        dashboardOrigin: stack.urls.dashboard,
        analyticsHmacKey: randomBytes(32).toString("hex"),
        allowPrivateHosts: true,
        // The whole point of this instance.
        emailTransport: "null",
      }),
      logFile: join(process.env.E2E_TMP_DIR ?? ".", "logs", "api-no-email.log"),
    });
    orphans.register(unconfigured.pid, "ssrf.spec.ts no-email API");
    await processes.waitFor({
      what: "the no-email API",
      watch: unconfigured,
      timeoutMs: 90_000,
      probe: () => isHealthy(unconfiguredUrl),
    });
  });

  test.afterAll(async () => {
    if (unconfigured) await processes.stop(unconfigured);
  });

  test("nothing is delivered, and nothing is written anywhere", async ({ stack }) => {
    const email = `e2e+${stack.runId}-noemail@rfphub.invalid`;
    const client = new ApiClient({ baseUrl: unconfiguredUrl });
    const response = await client.post<{ error?: string }>(
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
    );

    // THE LOAD-BEARING ASSERTION: no code exists anywhere. A transport that quietly wrote the code
    // somewhere readable would be far worse than one that drops it, so this is the half that has to
    // hold whatever the status line says.
    expect(
      existsSync(outboxFileFor(stack.outboxDir, email)),
      "an undeliverable transport must not leave a code lying about",
    ).toBe(false);

    // THE LOCKED DOOR NOW ANSWERS: the mount refuses to promise a code it cannot deliver, before
    // delegating to the library at all. 503, and honest about whose fault it is.
    expect(response.status, "send-verification-otp under EMAIL_TRANSPORT=null").toBe(503);
    expect(response.body).toEqual({
      error: "auth_unconfigured",
      message: "email delivery is not configured, so no sign-in code can be sent.",
    });

    // …and the route that CONSUMES a code is untouched: guarding it would turn "was a code ever
    // sent" into an oracle a caller could read off the verify response. A code that was never sent
    // simply fails to verify, exactly as a wrong code does.
    const verify = await client.post<{ code?: string }>("/api/auth/sign-in/email-otp", {
      email,
      otp: "000000",
    });
    expect(verify.status, "sign-in verify is unaffected by the transport").toBe(400);
    expect(verify.body.code).toBeDefined();
  });
});
