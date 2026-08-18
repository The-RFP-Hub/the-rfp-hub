/**
 * `scripts/check-m3.mjs`, run against the stack this suite just booted.
 *
 * The compliance checker is the broad HTTP conformance sweep — seven criteria, forty-nine checks,
 * over a live deployment. Playwright covers what only a browser can prove; this covers breadth. Its
 * one hard requirement is credentials, and that is where the two modes come from:
 *
 *   **real** — tokens for identities the provider actually issued. This is the mode that means what
 *   the tool's output says it means: a legitimate session, accepted by the API's own verification
 *   path, exercising the whole write surface.
 *
 *   **ephemeral** — no provider is reachable, so this mode generates an ES256 key pair locally,
 *   boots a SECOND API instance configured with that public key as its verification key, and signs
 *   its own tokens. This is the same seam `packages/api/test/helpers/auth.ts` uses, and it works
 *   for the same reason: the API verifies tokens locally against a configured PEM and cannot tell
 *   who signed them.
 *
 *   **What ephemeral mode is, precisely: DOMAIN EVIDENCE ONLY.** It establishes that the write
 *   path, the audit trail, deduplication, verification, analytics and staleness behave correctly
 *   over real HTTP against a real database. It establishes NOTHING about the identity provider —
 *   not that a real token would be accepted, not that the tenant is configured correctly, not that
 *   a person can sign in. The mode is stamped on the console output and written into the report so
 *   it cannot be quoted as if it were the real thing.
 *
 * The second instance is a deliberate choice over reconfiguring the first: the primary API is the
 * subject of every other assertion in the run, and swapping its verification key underneath those
 * assertions would make them mean something different. Two processes, one database, and the mode
 * recorded.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { ceremonyLogFile, grantAdmin } from "./admin-ceremony.js";
import { apiDir, apiEnv, checkM3Env, repoRoot } from "./env.js";
import { ApiClient, isHealthy } from "./http.js";
import * as ports from "./ports.js";
import { seedDocument } from "./privy/identities.js";
import * as processes from "./processes.js";
import { register } from "./redact.js";
import type { RunState } from "./state.js";
import { tokenForDid } from "./tokens.js";

export type CheckAuthMode = "real" | "ephemeral";

export interface CheckM3Input {
  state: RunState;
  tmp: string;
  onChild?: (child: processes.ManagedChild) => void;
}

interface CriterionSummary {
  id: string;
  name: string;
  status: string;
  tally: { pass: number; fail: number; warn: number; skip: number; info: number };
}

/** Boots whatever the chosen mode needs, runs the checker, prints per-area counts, returns its exit code. */
export async function runCheckM3(input: CheckM3Input): Promise<number> {
  const requested = process.env.E2E_CHECK_M3_AUTH as CheckAuthMode | undefined;
  const realAvailable = input.state.actors.admin !== undefined && !input.state.degradedNoPrivy;
  const mode: CheckAuthMode = requested ?? (realAvailable ? "real" : "ephemeral");

  if (mode === "real" && !realAvailable) {
    throw new Error(
      "run-check-m3: E2E_CHECK_M3_AUTH=real was requested, but this run has no real identity. " +
        "Set E2E_PRIVY_TENANT_ACK and the test-account variables, or let the mode fall back to ephemeral.",
    );
  }

  const children: processes.ManagedChild[] = [];
  try {
    const target =
      mode === "real"
        ? await realTarget(input.state)
        : await ephemeralTarget(input.state, input.tmp, children);

    banner(mode, target.baseUrl);

    const namespace = `m3e2e-${input.state.runId}-check`;
    const jsonPath = join(input.tmp, "m3-compliance-report.json");

    await ensureNamespace(target, namespace, input.state.urls.programme);

    const result = await processes.run(
      {
        name: "check-m3",
        command: "node",
        args: [
          "scripts/check-m3.mjs",
          "--base-url",
          target.baseUrl,
          "--namespace",
          namespace,
          "--application-url",
          input.state.urls.programme,
          "--json",
          jsonPath,
          "--no-color",
        ],
        cwd: repoRoot,
        // Credentials go through the ENVIRONMENT, never argv: `ps` prints a command line, and
        // these are a live session token and a live administrator session.
        env: checkM3Env({ privyToken: target.privyToken, adminToken: target.adminToken }),
      },
      input.onChild,
    );

    process.stdout.write(result.output);
    summarise(jsonPath, mode);
    return result.code ?? 1;
  } finally {
    await processes.stopAll(children);
  }
}

interface CheckTarget {
  baseUrl: string;
  privyToken: string;
  adminToken: string;
}

/**
 * Makes the checker's credential a VERIFIED PUBLISHER of the namespace it will write in.
 *
 * Without this the checker still runs, and still reports honestly — but five of its checks report
 * SKIP rather than PASS, each saying the same thing: the fixtures land `pending`, so there is no
 * public detail route to read, no link-out to click, and no approved entry for a duplicate search to
 * match against. Three whole criteria (duplicate detection, the snapshot digest, publisher
 * analytics) are only exercisable from an account that can publish, so a run without this step
 * establishes markedly less than the tool is capable of establishing.
 *
 * Every step goes through a real route, in the order the product requires: an organisation exists
 * only once an entry naming it has been submitted (there is no create-organisation endpoint), a
 * reviewer grants membership, and a reviewer verifies. This is the same sequence a real publisher
 * walks, which is why it is worth doing rather than reaching into the database.
 */
async function ensureNamespace(
  target: CheckTarget,
  namespace: string,
  applicationUrl: string,
): Promise<void> {
  const publisher = new ApiClient({ baseUrl: target.baseUrl, token: target.privyToken });
  const admin = new ApiClient({ baseUrl: target.baseUrl, token: target.adminToken });

  const me = (await publisher.expectOk({ path: "/v1/me" })) as { accountId: number };
  // The administrator's own first request, which is also what evaluates the bootstrap list.
  await admin.expectOk({ path: "/v1/me" });

  await publisher.expectOk({
    method: "POST",
    path: "/v1/opportunities",
    body: seedDocument(`${namespace}:checker-setup`, namespace, applicationUrl),
  });
  await admin.expectOk({
    method: "POST",
    path: `/v1/review/organizations/${namespace}/members`,
    body: { accountId: me.accountId, role: "publisher" },
  });
  await admin.expectOk({ method: "POST", path: `/v1/review/organizations/${namespace}/verify` });
}

/** Real identities: the publisher's session drives the write surface, the admin's the review side. */
async function realTarget(state: RunState): Promise<CheckTarget> {
  const publisher = state.actors.publisher ?? state.actors.admin;
  const admin = state.actors.admin;
  if (!publisher || !admin) throw new Error("run-check-m3: no publisher/admin identity to run as");

  const privyToken = await tokenForDid(publisher.did);
  const adminToken = await tokenForDid(admin.did);
  register(privyToken, { label: "privy-access-token", longLived: false });
  register(adminToken, { label: "privy-access-token", longLived: false });
  return { baseUrl: state.urls.api, privyToken, adminToken };
}

/**
 * A second API instance whose verification key this process holds the private half of.
 *
 * The DIDs are run-scoped and obviously synthetic (`did:privy:m3e2e-…`), so a row this checker
 * creates can never be mistaken for one a real identity created — in the database, in `audit_log`,
 * or in a report somebody reads six months from now.
 */
async function ephemeralTarget(
  state: RunState,
  tmp: string,
  children: processes.ManagedChild[],
): Promise<CheckTarget> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const verificationKey = await exportSPKI(pair.publicKey);

  const appId = `m3e2e-check-${state.runId}`;
  const publisherDid = `did:privy:m3e2e-${state.runId}-check-publisher`;
  const adminDid = `did:privy:m3e2e-${state.runId}-check-admin`;

  // The ephemeral checker's administrator is made the same way the run's is: by the operator
  // ceremony against the admin credential, not by anything in the API's environment.
  await grantAdmin({
    did: adminDid,
    adminDatabaseUrl: state.db.adminUrl,
    logFile: ceremonyLogFile(join(tmp, "logs"), "check-m3"),
  });

  const port = await ports.reserve(new Set(Object.values(state.ports)));
  const analyticsHmacKey = randomBytes(32).toString("hex");
  register(analyticsHmacKey, { label: "analytics-hmac-key", longLived: false });

  const api = processes.start({
    name: "api-check-m3",
    command: "pnpm",
    args: ["exec", "tsx", "src/server.ts"],
    cwd: apiDir,
    env: apiEnv({
      databaseUrl: state.db.runtimeUrl,
      port,
      appId,
      verificationKey,
      analyticsHmacKey,
      allowPrivateHosts: true,
    }),
    logFile: join(tmp, "logs", "api-check-m3.log"),
  });
  children.push(api);

  const baseUrl = `http://127.0.0.1:${port}`;
  await processes.waitFor({
    what: "check-m3 API /v1/health",
    watch: api,
    timeoutMs: 90_000,
    probe: () => isHealthy(baseUrl),
  });

  const mint = async (did: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(did)
      .setIssuer("privy.io")
      .setAudience(appId)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(pair.privateKey);
    register(token, { label: "ephemeral-session-token", longLived: false });
    return token;
  };

  return { baseUrl, privyToken: await mint(publisherDid), adminToken: await mint(adminDid) };
}

function banner(mode: CheckAuthMode, baseUrl: string): void {
  const lines =
    mode === "real"
      ? [`check:m3 auth mode: REAL — provider-issued session tokens against ${baseUrl}`]
      : [
          `check:m3 auth mode: EPHEMERAL — DOMAIN EVIDENCE ONLY, against ${baseUrl}`,
          "  Tokens are signed by a key pair generated in this process and injected into a dedicated",
          "  API instance as its verification key. This exercises the DOMAIN over real HTTP and a real",
          "  database. It does NOT exercise the identity provider, and must never be reported as if it did.",
        ];
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
}

/** Per-area pass counts, with the mode stamped on them so the two can never be quoted apart. */
function summarise(jsonPath: string, mode: CheckAuthMode): void {
  let report: {
    ok?: boolean;
    result?: string;
    summary?: Record<string, number>;
    criteria?: CriterionSummary[];
  };
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    process.stderr.write(`run-check-m3: could not read ${jsonPath}: ${(err as Error).message}\n`);
    return;
  }

  process.stdout.write(`\ncheck:m3 per-area result [auth mode: ${mode.toUpperCase()}]\n`);
  for (const criterion of report.criteria ?? []) {
    const { pass, fail, warn, skip } = criterion.tally;
    const extras = [
      fail ? `${fail} fail` : "",
      warn ? `${warn} warn` : "",
      skip ? `${skip} skip` : "",
    ]
      .filter(Boolean)
      .join(", ");
    process.stdout.write(
      `  ${criterion.status.toUpperCase().padEnd(5)} ${criterion.name.padEnd(24)} ${pass} pass${extras ? ` (${extras})` : ""}\n`,
    );
  }
  const summary = report.summary ?? {};
  process.stdout.write(
    `  total: ${summary.pass ?? 0} pass / ${summary.checks ?? 0} checks · result ${report.result ?? "(unknown)"}` +
      `${mode === "ephemeral" ? " · DOMAIN EVIDENCE ONLY" : ""}\n`,
  );
}
