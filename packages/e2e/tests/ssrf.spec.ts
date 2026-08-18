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
import { join } from "node:path";
import { apiDir, apiEnv, readTenantCredentials } from "../src/env.js";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";
import { ApiClient, isHealthy } from "../src/http.js";
import * as orphans from "../src/orphans.js";
import * as ports from "../src/ports.js";
import * as processes from "../src/processes.js";
import { tokenForDid } from "../src/tokens.js";

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
        appId: stack.privyAppId,
        // The SAME verification key the main instance runs on. Omitting it does not merely weaken
        // this instance — `privy-token.service.ts` answers 503 `auth_unconfigured` to every session
        // token when it is absent, so the reviewer credential these assertions need could not
        // authenticate at all and every refusal below would be an authentication failure wearing a
        // refusal's clothes.
        verificationKey: readTenantCredentials().verificationKey,
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
    const guarded = new ApiClient({ baseUrl, token: await tokenForDid(reviewer.did) });

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
