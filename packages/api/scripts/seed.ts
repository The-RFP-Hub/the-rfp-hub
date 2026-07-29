/**
 * Seed loader: ingest programs from an upstream funding-map registry API, map each to
 * the RFP Hub Standard, VALIDATE every record against the schema, and upsert only the ones that
 * pass (approved + listed). Target >=100 valid.
 *
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
 * Two modes, one pipeline:
 *   live     — page through the upstream registry. Deployment-specific: set SOURCE_API_URL (and
 *              optionally SOURCE_SYSTEM / SOURCE_PROGRAM_URL_BASE); see .env-example.
 *   offline  — `--from-file <path>` (or SEED_FIXTURE=<path>) reads a frozen corpus of raw upstream
 *              programs instead, with no network at all. That is what CI runs, against
 *              test/fixtures/seed-corpus.json, so the seed is reproducible and the gate has a
 *              fixed corpus to be strict about.
 * Mapping, validation and the floor are identical in both — only where the programs come from
 * differs. The Hub maps external data into the neutral Standard and never couples to any source's
 * internal schema.
 *
 * The upstream registry still speaks the PRE-RE-CUT vocabulary (`type`, bare organisation names, one
 * `deadline`, per-block date fields, `fundingMechanism`, `totalBudget`). `scripts/map-program.ts`
 * is where that conversion to the re-cut Standard lives, following the same rules the Standard's
 * own examples were regenerated with; everything downstream of it is already re-cut-shaped.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Opportunity } from "@the-rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { config } from "../src/config.js";
import { type DB, db, pool } from "../src/db/client.js";
import { OpportunityService } from "../src/modules/services/opportunities/opportunity.service.js";
import { type RegistryProgram, mapProgram } from "./map-program.js";

const TARGET = Number(process.env.SEED_TARGET ?? 120);
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MIN_VALID = 100;
const INVOCATION_ID = randomUUID();

const FIXTURE_FLAG = "--from-file";

export interface RejectedRecord {
  id: string;
  errors: string[];
}

/** How a run is invoked. Never what it validates — the gate is the same in every mode. */
export interface SeedOptions {
  strict: boolean;
  /** Path to a frozen corpus. Present ⇒ offline mode: no network call is made at all. */
  fixturePath?: string;
}

/**
 * Read the run's mode off argv/env. `--from-file <path>` and `--from-file=<path>` both work, and
 * SEED_FIXTURE is the env equivalent (CI sets flags, containers set env). An empty
 * `--from-file` is an error rather than a silent fall-through to the network: a run that meant to
 * be offline must never quietly hit the upstream instead.
 */
export function parseSeedOptions(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): SeedOptions {
  let fixturePath: string | undefined;
  const inlined = argv.find((a) => a.startsWith(`${FIXTURE_FLAG}=`));
  const flagIndex = argv.indexOf(FIXTURE_FLAG);
  if (inlined) fixturePath = inlined.slice(FIXTURE_FLAG.length + 1);
  else if (flagIndex !== -1) {
    const next = argv[flagIndex + 1];
    // the next flag is not a path — `--from-file --strict` is a missing path, not a file named
    // "--strict", and swallowing it would turn an offline run into a live one
    fixturePath = next?.startsWith("--") ? undefined : next;
  }
  if ((inlined || flagIndex !== -1) && !fixturePath?.trim()) {
    throw new Error(`${FIXTURE_FLAG} needs a path to a frozen corpus JSON file`);
  }
  return {
    strict: argv.includes("--strict") || env.SEED_STRICT === "1",
    fixturePath: fixturePath ?? (env.SEED_FIXTURE?.trim() || undefined),
  };
}

/**
 * A frozen corpus is raw UPSTREAM programs — the source side of the contract, not Standard
 * objects — either as a bare array or under `programs` in an envelope that can carry a note.
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

/** Offline source: the committed corpus, read straight off disk. */
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
 * default because the upstream is a third-party feed we do not control: one malformed program
 * should not block a 120-record seed. On in CI against a fixed corpus, where it should.
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
      `seed contract violated: only ${valid} valid entries (< ${min}) — raise SEED_TARGET or check the source`,
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

async function fetchPage(page: number): Promise<{ programs: RegistryProgram[]; hasNext: boolean }> {
  const url = new URL("/v2/program-registry/search", config.sourceApiUrl);
  url.searchParams.set("isValid", "accepted");
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sortField", "updatedAt");
  url.searchParams.set("sortOrder", "desc");

  const res = await fetch(url, {
    headers: { "X-Source": "rfp-hub-api:seed", "X-Invocation-Id": INVOCATION_ID },
  });
  if (!res.ok) throw new Error(`source registry API ${res.status} on page ${page}`);
  const body = (await res.json()) as { programs?: RegistryProgram[]; hasNext?: boolean };
  return { programs: body.programs ?? [], hasNext: Boolean(body.hasNext) };
}

async function main(): Promise<void> {
  const { strict, fixturePath } = parseSeedOptions(process.argv);
  if (!fixturePath && !config.sourceApiUrl) {
    throw new Error(
      `SOURCE_API_URL is not set — point it at an upstream funding-map registry API (see .env-example), or seed offline with ${FIXTURE_FLAG} <path>`,
    );
  }
  const mapOpts = {
    sourceSystem: config.sourceSystem,
    programUrlBase: config.sourceProgramUrlBase || undefined,
  };
  // Offline: one batch, read once, no network. Live: paged until TARGET or the source runs out.
  const corpus = fixturePath ? await readCorpus(fixturePath) : undefined;
  console.log(
    `Seeding from ${corpus ? `${fixturePath} (frozen corpus, ${corpus.length} programs)` : config.sourceApiUrl} (target ${TARGET} valid${strict ? ", --strict" : ""})…`,
  );
  const seen = new Set<string>();
  const valid: Opportunity[] = [];
  const rejected: RejectedRecord[] = [];

  for (let page = 1; page <= MAX_PAGES && valid.length < TARGET; page++) {
    const { programs, hasNext } = corpus
      ? { programs: corpus, hasNext: false }
      : await fetchPage(page);
    if (programs.length === 0) break;

    const mapped: Opportunity[] = [];
    for (const program of programs) {
      const std = mapProgram(program, mapOpts);
      if (seen.has(std.id)) continue;
      seen.add(std.id);
      mapped.push(std);
    }

    // Every mapped record is schema-validated here, before anything touches the database.
    const gate = gateForSeed(mapped);
    valid.push(...gate.accepted);
    rejected.push(...gate.rejected);
    reportRejections(gate.rejected);

    console.log(
      `  ${corpus ? "corpus" : `page ${page}`}: ${valid.length} valid, ${rejected.length} rejected`,
    );
    if (!hasNext) break;
  }

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
          sourceSystem: config.sourceSystem,
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
