/**
 * Seed loader: read a corpus of raw upstream programs FROM A FILE, map each to the RFP Hub
 * Standard, VALIDATE every record against the schema, and upsert only the ones that pass
 * (approved + listed). Target >=100 valid.
 *
 *   pnpm --filter @the-rfp-hub/api seed test/fixtures/seed-corpus.json --strict
 *
 * ── A file is the only input, on purpose ───────────────────────────────────────────
 * Acquiring data and loading data are two jobs with two different failure modes, so they are two
 * programs. This one is the loader: deterministic, offline, secret-free and therefore runnable in
 * CI on a clean checkout — the same file in, the same rows out, every run. It opens no socket and
 * reads no credential. Fetching from an upstream registry lives in `scripts/fetch-corpus.ts`,
 * which is the only place SOURCE_API_URL is read; its output is a corpus file this script
 * consumes. See packages/api/README.md ("Seeding: fetch → file → seed").
 *
 * ── The gate ───────────────────────────────────────────────────────────────────────
 * Validation is not optional and not a flag: `gateForSeed` runs on every mapped record before
 * anything reaches the database, and each rejection is printed with its id and the rules it broke.
 * Pass `--strict` (or SEED_STRICT=1) to turn any rejection into a failed run.
 *
 * Nothing is written until the whole batch has been mapped, validated AND counted: the >=100 floor
 * is asserted BEFORE the first upsert, so a short or broken run fails with the database untouched
 * rather than leaving a partial approved+listed dataset live behind it. The write phase itself runs
 * inside ONE transaction, so a failure at record 57 of 143 (connection reset, statement timeout, a
 * unique-constraint collision in the organizations directory) rolls the whole batch back instead of
 * publishing a half-updated mix of this run's and the previous run's rows.
 *
 * The upstream registry still speaks the PRE-RE-CUT vocabulary (`type`, bare organisation names, one
 * `deadline`, per-block date fields, `fundingMechanism`, `totalBudget`). `scripts/map-program.ts`
 * is where that conversion to the re-cut Standard lives, following the same rules the Standard's
 * own examples were regenerated with; everything downstream of it is already re-cut-shaped.
 */
import { readFile } from "node:fs/promises";
import type { Opportunity } from "@the-rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { type DB, db, pool } from "../src/db/client.js";
import { OpportunityService } from "../src/modules/services/opportunities/opportunity.service.js";
import { type RegistryProgram, SOURCE_SYSTEM, mapProgram } from "./map-program.js";

const MIN_VALID = 100;

const USAGE = "usage: pnpm seed <path-to-corpus.json> [--strict]";

export interface RejectedRecord {
  id: string;
  errors: string[];
}

/** How a run is invoked. Never what it validates — the gate does not vary. */
export interface SeedOptions {
  /** Path to the corpus of raw upstream programs. Required: there is no other source. */
  corpusPath: string;
  strict: boolean;
}

/**
 * Read the run's inputs off argv/env. The corpus path is the one positional argument — with a
 * single mode there is nothing for a `--from-file` flag to distinguish it from, and a required
 * argument that is simply missing fails louder than a flag that can be left off.
 */
export function parseSeedOptions(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): SeedOptions {
  const positional = argv.slice(2).filter((a) => !a.startsWith("-"));
  if (positional.length === 0) throw new Error(`no corpus file given — ${USAGE}`);
  if (positional.length > 1) {
    throw new Error(`expected one corpus file, got ${positional.length} — ${USAGE}`);
  }
  const corpusPath = positional[0] as string;
  if (!corpusPath.trim()) throw new Error(`no corpus file given — ${USAGE}`);
  return { corpusPath, strict: argv.includes("--strict") || env.SEED_STRICT === "1" };
}

/**
 * A corpus is raw UPSTREAM programs — the source side of the contract, not Standard objects —
 * either as a bare array or under `programs` in an envelope that can carry a note.
 * Anything else is a hard error: a corpus that silently parses to zero programs would sail past
 * mapping and only surface as a mystifying floor violation.
 */
export function programsFromCorpus(parsed: unknown, path = "corpus"): RegistryProgram[] {
  const programs = Array.isArray(parsed)
    ? parsed
    : (parsed as { programs?: unknown } | null)?.programs;
  if (!Array.isArray(programs)) {
    throw new Error(`${path}: expected an array of upstream programs, or { programs: [...] }`);
  }
  if (programs.length === 0) throw new Error(`${path}: contains no programs`);
  return programs as RegistryProgram[];
}

/** The one and only source of programs: a corpus file, read straight off disk. */
export async function readCorpus(path: string): Promise<RegistryProgram[]> {
  return programsFromCorpus(JSON.parse(await readFile(path, "utf8")), path);
}

export interface SeedGateResult {
  accepted: Opportunity[];
  rejected: RejectedRecord[];
}

/**
 * The ingestion gate. NOTHING reaches the database without passing this.
 *
 * `FIELDS.md` design principle 2 says provenance and shape are asserted by ingestion policy
 * rather than by schema validation at read time — this function is that policy, in the one place
 * it can actually be enforced. A rejected record is reported with its id and the rules it broke;
 * it is never counted and dropped in silence, because a silent drop is how a seed quietly loads
 * 40 records and reports success.
 */
export function gateForSeed(mapped: readonly Opportunity[]): SeedGateResult {
  const accepted: Opportunity[] = [];
  const rejected: RejectedRecord[] = [];
  for (const record of mapped) {
    const { valid, errors } = validateOpportunity(record, { checks: false });
    if (valid) accepted.push(record);
    else rejected.push({ id: record.id ?? "(no id)", errors: humanizeErrors(errors, record) });
  }
  return { accepted, rejected };
}

/** Print every rejection with its id and the rules it broke. Loud by construction. */
export function reportRejections(rejected: readonly RejectedRecord[]): void {
  for (const { id, errors } of rejected) {
    console.error(`  ✗ ${id} failed schema validation:`);
    for (const line of errors) console.error(`      - ${line}`);
  }
}

/**
 * With `--strict` (or SEED_STRICT=1), a single non-conforming record fails the whole run. Off by
 * default because a corpus is a recording of a third-party feed we do not control: one malformed
 * program should not block a 143-record seed. On in CI against the committed corpus, where it
 * should — that file cannot change without a reviewed commit.
 */
export function assertNoRejections(rejected: readonly RejectedRecord[], strict: boolean): void {
  if (!strict || rejected.length === 0) return;
  throw new Error(
    `--strict: ${rejected.length} mapped record(s) failed schema validation: ${rejected
      .map((r) => r.id)
      .join(", ")}`,
  );
}

/**
 * Hard floor on the seed: throw (non-zero exit via the top-level catch) if too few records passed
 * the gate. Called on the validated batch BEFORE the first upsert — see main().
 */
export function assertSeedContract(valid: number, min = MIN_VALID): void {
  if (valid < min) {
    throw new Error(
      `seed contract violated: only ${valid} valid entries (< ${min}) — check the corpus file`,
    );
  }
}

/**
 * The write phase, and the two guards that come BEFORE it — in that order, in one place, so the
 * order is a testable property rather than a comment. Everything up to here is read-only: a run
 * that fails either guard leaves the database exactly as it found it, instead of publishing a
 * partial approved+listed dataset and only then reporting failure.
 *
 * The guards are only half the property, though: a failure INSIDE the loop would leave the records
 * written so far live. main() therefore calls this inside a single `db.transaction`, so the whole
 * write phase commits or rolls back as one unit. `write` is injected rather than reached for so
 * this can be exercised without a database.
 */
export async function loadValidated(
  valid: readonly Opportunity[],
  rejected: readonly RejectedRecord[],
  write: (std: Opportunity) => Promise<void>,
  opts: { strict: boolean; min?: number },
): Promise<number> {
  assertNoRejections(rejected, opts.strict);
  assertSeedContract(valid.length, opts.min);

  let loaded = 0;
  for (const std of valid) {
    await write(std);
    loaded++;
  }
  return loaded;
}

async function main(): Promise<void> {
  const { corpusPath, strict } = parseSeedOptions(process.argv);
  const corpus = await readCorpus(corpusPath);
  console.log(
    `Seeding from ${corpusPath} (${corpus.length} upstream programs${strict ? ", --strict" : ""})…`,
  );

  // One batch, read once, no network. Duplicate ids inside a corpus are dropped rather than
  // upserted twice, so the count reported is the count of distinct records.
  const seen = new Set<string>();
  const mapped: Opportunity[] = [];
  for (const program of corpus) {
    const std = mapProgram(program);
    if (seen.has(std.id)) continue;
    seen.add(std.id);
    mapped.push(std);
  }

  // Every mapped record is schema-validated here, before anything touches the database.
  const { accepted: valid, rejected } = gateForSeed(mapped);
  reportRejections(rejected);
  console.log(`  ${valid.length} valid, ${rejected.length} rejected`);

  // One transaction for the whole write phase — see loadValidated. The service is bound to the
  // transaction handle rather than the pool so every upsert (opportunities AND the organizations
  // directory) joins it; the handle exposes the same query surface as `db` but is not structurally
  // assignable to it, hence the cast.
  const loaded = await db.transaction(async (tx) => {
    const ctl = new OpportunityService(tx as unknown as DB);
    return loadValidated(
      valid,
      rejected,
      (std) =>
        ctl.upsertFromStandard(std, {
          reviewStatus: "approved",
          isListed: true,
          sourceSystem: SOURCE_SYSTEM,
        }),
      { strict },
    );
  });

  console.log(
    `✓ ${loaded} opportunities loaded, ${rejected.length} rejected (schema-invalid, listed above)`,
  );
  await pool.end();
}

// CLI entry — skipped under Vitest so tests can import the pure helper without a live seed run.
if (!process.env.VITEST) {
  main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
