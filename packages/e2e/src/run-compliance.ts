/**
 * `scripts/accept-writes.mjs`, run against the stack this suite just booted.
 *
 * The compliance checker is the broad HTTP conformance sweep — seven criteria, forty-nine checks,
 * over a live deployment. Playwright covers what only a browser can prove; this covers breadth.
 *
 * THERE USED TO BE TWO MODES HERE, and collapsing them is the point of this migration. The
 * checker's one hard requirement is credentials, and credentials used to mean a third party: when
 * one was reachable the run was "real", and when it was not the runner generated an ES256 key pair,
 * booted a SECOND API pinned to it, signed its own tokens, and stamped the output DOMAIN EVIDENCE
 * ONLY — an honest label for a run that proved the domain and nothing about authentication.
 *
 * Signing in needs no third party now. There is one target, one API, and one kind of token: the one
 * a person gets by typing a code. `E2E_CHECK_M3_AUTH`, `ephemeralTarget()` and the whole mode
 * distinction are deleted.
 *
 * THE CAVEAT NARROWS RATHER THAN DISAPPEARING. This run establishes nothing about Google — that
 * lane is separate and opt-in. The email path it exercises is the real one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complianceEnv, repoRoot } from "./env.js";
import { ApiClient, isHealthy } from "./http.js";
import { seedDocument } from "./identity/actors.js";
import { sessionFor } from "./identity/sessions.js";
import * as processes from "./processes.js";
import { register } from "./redact.js";
import type { RunState } from "./state.js";

export interface ComplianceRunInput {
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

/** Signs in, runs the checker against the live stack, prints per-area counts, returns its exit code. */
export async function runCompliance(input: ComplianceRunInput): Promise<number> {
  const children: processes.ManagedChild[] = [];
  try {
    const target = await signedInTarget(input.state);
    banner(target.baseUrl);

    const namespace = `e2e-${input.state.runId}-compliance`;
    const jsonPath = join(input.tmp, "accept-report.json");

    await ensureNamespace(target, namespace, input.state.urls.programme);

    const result = await processes.run(
      {
        name: "accept-writes",
        command: "node",
        args: [
          "scripts/accept-writes.mjs",
          "--milestone",
          "m3",
          "--api",
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
        env: complianceEnv({ sessionToken: target.sessionToken, adminToken: target.adminToken }),
      },
      input.onChild,
    );

    process.stdout.write(result.output);
    summarise(jsonPath);
    return result.code ?? 1;
  } finally {
    await processes.stopAll(children);
  }
}

interface CheckTarget {
  baseUrl: string;
  sessionToken: string;
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
  const publisher = new ApiClient({ baseUrl: target.baseUrl, token: target.sessionToken });
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

/**
 * The one target: the running API, driven by two identities that signed in the ordinary way.
 *
 * The publisher's session drives the write surface, the administrator's the review side. Both are
 * the same kind of token a person holds — there is no second class of credential any more.
 */
async function signedInTarget(state: RunState): Promise<CheckTarget> {
  const publisher = state.actors.publisher ?? state.actors.admin;
  const admin = state.actors.admin;
  if (!publisher || !admin)
    throw new Error("run-compliance: no publisher/admin identity to run as");

  const sessionToken = (await sessionFor(publisher.email)).token;
  const adminToken = (await sessionFor(admin.email)).token;
  register(sessionToken, { label: "session-token", longLived: false });
  register(adminToken, { label: "session-token", longLived: false });
  return { baseUrl: state.urls.api, sessionToken, adminToken };
}

function banner(baseUrl: string): void {
  process.stdout.write(
    `\naccept:writes --milestone m3 — real sessions, obtained by signing in, against ${baseUrl}\n  This establishes nothing about Google; that lane is separate and opt-in. The email path it\n  exercises is the real one — the same sign-in a person performs.\n\n`,
  );
}

/** Per-area pass counts. */
function summarise(jsonPath: string): void {
  let report: {
    ok?: boolean;
    result?: string;
    summary?: Record<string, number>;
    criteria?: CriterionSummary[];
  };
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    process.stderr.write(`run-compliance: could not read ${jsonPath}: ${(err as Error).message}\n`);
    return;
  }

  process.stdout.write("\ncompliance per-area result\n");
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
    `  total: ${summary.pass ?? 0} pass / ${summary.checks ?? 0} checks · result ${report.result ?? "(unknown)"}\n`,
  );
}
