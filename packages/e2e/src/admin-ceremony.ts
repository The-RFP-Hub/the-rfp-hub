/**
 * The operator ceremony that makes the run's first administrator.
 *
 * WHY THIS EXISTS AT ALL. The API used to promote a list of identities named in its own environment.
 * It no longer does, and the reason is worth restating where the harness performs the replacement: a
 * privileged-identity list in a service's configuration grants the role on every login, to whoever
 * holds that configuration, and nothing inside the product can revoke it. The grant is now an EVENT
 * — performed once with the database credential, audited, and revocable afterwards by any
 * administrator over the ordinary role route.
 *
 * So the harness does what an operator does: it runs the shipped CLI, with the ADMIN database URL in
 * the child's environment, against the DID the rotation selected for this run. Nothing about the
 * admin's privileges is configured into the API process any more.
 */
import { join } from "node:path";
import { apiDir, repoRoot } from "./env.js";
import * as processes from "./processes.js";

export interface GrantAdminResult {
  /** The CLI's own summary line: "granted: …" on the first run, "unchanged: …" on a repeat. */
  outcome: "granted" | "unchanged";
  exitCode: number;
  output: string;
}

/**
 * Runs `grant-admin` for one DID. Throws on any refusal — a run whose administrator was not made is
 * a run whose whole privileged surface is untestable, and that must fail loudly at bring-up rather
 * than as forty confusing 403s later.
 *
 * `--create` provisions the account when the identity has never logged in, which is the normal case
 * here: the ceremony happens during bring-up, before anyone has authenticated. It is also why the
 * just-in-time provisioning assertion deliberately watches a NON-administrator identity — the
 * administrator's account now exists before its first request, by design.
 */
export async function grantAdmin(options: {
  did: string;
  adminDatabaseUrl: string;
  logFile: string;
}): Promise<GrantAdminResult> {
  const result = await processes.run({
    name: "grant-admin",
    command: "pnpm",
    args: [
      "--filter",
      "@the-rfp-hub/api",
      "grant-admin",
      "--",
      "--did",
      options.did,
      "--create",
      "--yes",
    ],
    cwd: repoRoot,
    // The ceremony's whole point is that it uses the MIGRATION credential, not the runtime role.
    // Built from `{}` like every other child environment; `PATH`/`HOME` come from `migrateEnv`'s
    // base, and `DATABASE_URL` is the admin URL.
    env: ceremonyEnv(options.adminDatabaseUrl),
    logFile: options.logFile,
  });

  if (result.code !== 0) {
    throw new Error(
      `grant-admin exited ${result.code} for ${options.did}. The run has no administrator, so every ` +
        `privileged criterion would fail for the wrong reason.\n${result.output}`,
    );
  }

  // The CLI's vocabulary is part of its frozen contract: "granted" on a fresh promotion, "unchanged"
  // when the account was already an administrator. Both are exit 0; the distinction is what makes
  // idempotence observable.
  const outcome = /(^|\n)unchanged:/.test(result.output) ? "unchanged" : "granted";
  return { outcome, exitCode: result.code ?? 0, output: result.output };
}

/** Where a ceremony invocation's output is kept, alongside the other child logs. */
export function ceremonyLogFile(logDir: string, label: string): string {
  return join(logDir, `grant-admin-${label}.log`);
}

function ceremonyEnv(adminDatabaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "SHELL", "LANG", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NODE_ENV = "test";
  env.DATABASE_URL = adminDatabaseUrl;
  return env;
}

/** Re-exported so callers do not need to know the CLI lives under `packages/api`. */
export const CEREMONY_CWD = apiDir;
