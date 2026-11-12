/**
 * Organizations that only REJECTED entries name — found, reported, and deleted only when told to.
 *
 * Before submissions stopped writing directory details (`modules/shared/organization-directory.ts`),
 * the first submission to name a slug wrote that organization's website, logo, description, social
 * links and contacts, and rejecting the submission left all of it behind. This lists every such
 * row that nothing else holds on to, and with `--apply` deletes them:
 *
 *   - not verified (a verified organization is never touched, whatever names it);
 *   - not named by any opportunity that is not rejected, including uncited stubs;
 *   - no membership, no invite and no claim — each would be deleted with it by cascade, which is
 *     not this script's decision to make.
 *
 * The rejected entries themselves are left alone: each keeps its own copy of the organizations it
 * named, which is what the review trail shows. If a later submission names the slug again, it gets
 * a fresh stub under today's rules.
 *
 *   pnpm --filter @the-rfp-hub/api orgs:cleanup-rejected              # report only
 *   pnpm --filter @the-rfp-hub/api orgs:cleanup-rejected -- --apply   # delete, audited
 *
 * `DATABASE_URL` comes from the environment. Like `grant-admin`, it echoes host, port and database
 * (never the URL), and refuses a target that is not loopback without `--allow-remote`. Each
 * deletion re-checks the conditions under the DELETE itself and is audited on the organization as
 * an `update_organization` with `deleted: true` and the directory entry as it was.
 */
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { db, pool } from "../src/db/client.js";
import {
  type Repositories,
  repositories,
  withTransaction,
} from "../src/modules/repositories/index.js";
import { SYSTEM_ACTOR } from "../src/modules/services/audit/audit.service.js";
import { organizationDirectoryView } from "../src/modules/shared/organization-directory.js";
import { isLoopbackHost } from "../src/shared/loopback.js";

export interface CleanupOptions {
  apply: boolean;
  log: (line: string) => void;
  /** Narrow the candidates by slug. The integration suite uses it to stay inside its own fixtures. */
  only?: (slug: string) => boolean;
}

export interface CleanupResult {
  found: string[];
  deleted: string[];
}

export async function cleanupRejectedOrganizationStubs(
  repos: Repositories,
  options: CleanupOptions,
): Promise<CleanupResult> {
  const candidates = (await repos.organizations.citedOnlyByRejected()).filter(
    (row) => options.only?.(row.slug) ?? true,
  );
  for (const row of candidates) {
    options.log(
      `${options.apply ? "deleting" : "would delete"}: ${row.slug} (${JSON.stringify(row.name)}) website=${row.website ?? "-"} created_at=${row.createdAt.toISOString()}`,
    );
  }
  if (!options.apply) {
    options.log(`${candidates.length} found; nothing deleted (re-run with --apply to delete).`);
    return { found: candidates.map((row) => row.slug), deleted: [] };
  }

  const deleted = await repos.organizations.deleteIfStillCitedOnlyByRejected(
    candidates.map((row) => row.id),
  );
  const gone = new Set(deleted);
  for (const row of candidates) {
    if (!gone.has(row.slug)) {
      options.log(`kept: ${row.slug} changed since it was listed`);
      continue;
    }
    await repos.audit.record({
      ...SYSTEM_ACTOR,
      subjectKind: "organization",
      subjectId: row.id,
      action: "update_organization",
      patch: {
        deleted: true,
        reason: "named_only_by_rejected_entries",
        directory: organizationDirectoryView(row),
      },
    });
  }
  options.log(`${candidates.length} found; ${deleted.length} deleted.`);
  return { found: candidates.map((row) => row.slug), deleted };
}

const USAGE = [
  "Usage: pnpm --filter @the-rfp-hub/api orgs:cleanup-rejected -- [--apply] [--allow-remote]",
  "",
  "  --apply          delete what is listed (in one transaction, audited); without it, report only",
  "  --allow-remote   permit a DATABASE_URL that is not loopback",
].join("\n");

export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  let apply = false;
  let allowRemote = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--allow-remote") allowRemote = true;
    else if (arg === "--help" || arg === "-h") {
      out(USAGE);
      return 0;
    } else {
      out(`unknown argument ${JSON.stringify(arg)}`);
      out(USAGE);
      return 2;
    }
  }

  const url = new URL(config.databaseUrl);
  out(`database: ${url.hostname}:${url.port || "5432"}/${url.pathname.replace(/^\//, "")}`);
  if (!isLoopbackHost(url.hostname) && !allowRemote) {
    out(
      `refusing: ${url.hostname} is not loopback. Re-run with --allow-remote if that is the database you mean.`,
    );
    return 1;
  }

  if (!apply) {
    await cleanupRejectedOrganizationStubs(repositories(db), { apply: false, log: out });
    return 0;
  }
  await withTransaction(db, (repos) =>
    cleanupRejectedOrganizationStubs(repos, { apply: true, log: out }),
  );
  return 0;
}

// Run only when this file IS the entry point, so a test can import it without touching anything.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
  await pool.end();
}
