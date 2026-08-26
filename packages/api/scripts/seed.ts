/**
 * Seed loader: read RFP Hub Standard documents FROM A FILE, VALIDATE every one against the schema,
 * and upsert only the ones that pass (approved + listed). Target >=100 valid.
 *
 *   pnpm --filter @the-rfp-hub/api seed data/seed-corpus.json --strict
 *
 * ── The corpus is already Standard, on purpose ─────────────────────────────────────
 * `data/seed-corpus.json` holds finished Standard v1.0.0 documents, not a foreign registry's rows.
 * The dataset is a repo artifact: it is curated, reviewed and versioned here like any other source
 * file, so the shape a reviewer reads in the diff is exactly the shape that is served. There is no
 * mapping step on this path and therefore no mapping to get wrong between review and serve.
 *
 * Rebuilding that dataset in bulk from some upstream registry is a DIFFERENT job with a different
 * failure mode — non-deterministic, credentialed, network-bound — and it lives outside the runtime
 * entirely, in `tools/converter/` (offline, run by hand, never by CI, never by the server). Nothing
 * on this path reads an upstream pointer; nothing on this path opens a socket. See
 * packages/api/README.md ("Seeding: a static, in-repo corpus").
 *
 * ── The gate ───────────────────────────────────────────────────────────────────────
 * Validation is not optional and not a flag: `gateForSeed` runs on every document before anything
 * reaches the database, and each rejection is printed with its id and the rules it broke. A curated
 * file is not a trusted file — it is edited by hand, which is precisely why every record is
 * re-validated on the way in. Pass `--strict` (or SEED_STRICT=1) to turn any rejection into a
 * failed run; CI runs it on. `--strict` is SCHEMA-strict: the gate runs the validator with its
 * advisory checks off, so a warning never fails a seed. The corpus's advisory baseline is asserted
 * separately, and itemised, in test/unit/seed-corpus.test.ts.
 *
 * Duplicate ids are the one input defect that fails the run with or without `--strict` — see
 * `assertUniqueIds`. Nothing is deduplicated: every document in the file reaches the gate.
 *
 * Nothing is written until the whole batch has been validated AND counted: the >=100 floor is
 * asserted BEFORE the first upsert, so a short or broken run fails with the database untouched
 * rather than leaving a partial approved+listed dataset live behind it. The write phase itself runs
 * inside ONE transaction, so a failure at record 57 of 142 (connection reset, statement timeout, a
 * unique-constraint collision in the organizations directory) rolls the whole batch back instead of
 * publishing a half-updated mix of this run's and the previous run's rows.
 */
import { readFile } from "node:fs/promises";
import type { Opportunity } from "@the-rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { db, pool } from "../src/db/client.js";
import { withTransaction } from "../src/modules/repositories/index.js";
import { upsertOpportunityFromStandard } from "../src/modules/services/opportunities/opportunity.service.js";

const MIN_VALID = 100;

const USAGE = "usage: pnpm seed <path-to-corpus.json> [--strict]";

export interface RejectedRecord {
  id: string;
  errors: string[];
}

/** How a run is invoked. Never what it validates — the gate does not vary. */
export interface SeedOptions {
  /** Path to the corpus of Standard documents. Required: there is no other source. */
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
 * A corpus is Standard documents — either as a bare array or under `documents` in an envelope that
 * can carry a note. Anything else is a hard error: a corpus that silently parses to zero documents
 * would sail past the gate and only surface as a mystifying floor violation.
 */
export function documentsFromCorpus(parsed: unknown, path = "corpus"): Opportunity[] {
  const documents = Array.isArray(parsed)
    ? parsed
    : (parsed as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) {
    throw new Error(`${path}: expected an array of Standard documents, or { documents: [...] }`);
  }
  if (documents.length === 0) throw new Error(`${path}: contains no documents`);
  return documents as Opportunity[];
}

/** The one and only source of documents: a corpus file, read straight off disk. */
export async function readCorpus(path: string): Promise<Opportunity[]> {
  return documentsFromCorpus(JSON.parse(await readFile(path, "utf8")), path);
}

/**
 * The provenance namespace a document declares, read off its own id (`fundingmap:1459` →
 * `fundingmap`, `curated:lido-bug-bounty` → `curated`). It is recorded in the `source_system`
 * column, where it pairs with `original_id` in the partial uniqueness index over the two.
 *
 * Derived rather than configured, and derived from the DOCUMENT rather than from a constant this
 * script carries: the id is what consumers already see, so a `source_system` taken from anywhere
 * else could disagree with it. That matters most for the corpus's two provenance classes — records
 * converted from an upstream registry snapshot keep that registry's namespace and its
 * `source.originalId`; records researched here from the funder's own pages carry `curated` and no
 * original id, because they never had one. A namespace-free id yields null, which the column
 * permits (the uniqueness index is partial for exactly that reason).
 */
export function sourceSystemOf(id: string | undefined): string | null {
  const namespace = (id ?? "").split(":")[0];
  return namespace && namespace !== id ? namespace : null;
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
export function gateForSeed(documents: readonly Opportunity[]): SeedGateResult {
  const accepted: Opportunity[] = [];
  const rejected: RejectedRecord[] = [];
  for (const record of documents) {
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
 * Duplicate ids are a CORPUS defect, not a record defect, and they fail the run outright — with or
 * without `--strict`.
 *
 * The loader used to dedupe by id before the gate, which was wrong twice over: the second copy was
 * never validated, and it was dropped without a word. Two documents sharing an id are two answers
 * to the same question, and nothing here can tell which one the curator meant — a merge conflict
 * resolved by taking both sides, a copy-paste that kept the id, an upstream that reissued one. This
 * is a hand-edited file, so that is exactly the mistake it should be loud about, and "silently kept
 * the first" is the one resolution a reviewer cannot see in a green run.
 */
export function assertUniqueIds(documents: readonly Opportunity[]): void {
  const counts = new Map<string, number>();
  for (const d of documents) {
    const id = d?.id ?? "(no id)";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicated = [...counts].filter(([, n]) => n > 1);
  if (duplicated.length === 0) return;
  throw new Error(
    `duplicate id(s) in the corpus: ${duplicated
      .map(([id, n]) => `${id} (×${n})`)
      .join(", ")} — ids must be unique; nothing was written`,
  );
}

/**
 * With `--strict` (or SEED_STRICT=1), a single non-conforming record fails the whole run. It is off
 * by default so that an operator loading their own hand-assembled corpus is not blocked by one bad
 * record in it. On in CI against the committed corpus, where it should be: that file cannot change
 * without a reviewed commit, so a single rejection there is a defect, not weather.
 */
export function assertNoRejections(rejected: readonly RejectedRecord[], strict: boolean): void {
  if (!strict || rejected.length === 0) return;
  throw new Error(
    `--strict: ${rejected.length} document(s) failed schema validation: ${rejected
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
 * The write phase, and the three guards that come BEFORE it — in that order, in one place, so the
 * order is a testable property rather than a comment. Everything up to here is read-only: a run
 * that fails any guard leaves the database exactly as it found it, instead of publishing a
 * partial approved+listed dataset and only then reporting failure.
 *
 * The guards are only half the property, though: a failure INSIDE the loop would leave the records
 * written so far live. main() therefore calls this inside a single repository unit of work, so the
 * whole write phase commits or rolls back as one unit. `write` is injected rather than reached for
 * so this can be exercised without a database.
 */
export async function loadValidated(
  valid: readonly Opportunity[],
  rejected: readonly RejectedRecord[],
  write: (std: Opportunity) => Promise<void>,
  opts: { strict: boolean; min?: number },
): Promise<number> {
  assertNoRejections(rejected, opts.strict);
  assertUniqueIds(valid);
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
    `Seeding from ${corpusPath} (${corpus.length} Standard documents${strict ? ", --strict" : ""})…`,
  );

  // One batch, read once, no network. Duplicate ids fail the run here, on the RAW input, so a
  // collision is named even when one of the two copies would also have failed the schema gate.
  assertUniqueIds(corpus);

  // Every document is schema-validated here, before anything touches the database. Nothing is
  // filtered out on the way in: whatever the file holds, the gate sees.
  const { accepted: valid, rejected } = gateForSeed(corpus);
  reportRejections(rejected);
  console.log(`  ${valid.length} valid, ${rejected.length} rejected`);

  // One transaction for the whole write phase — see loadValidated. Every upsert (opportunities AND
  // the organizations directory) runs through the repositories bound to that held connection.
  const loaded = await withTransaction(db, async (repos) => {
    return loadValidated(
      valid,
      rejected,
      (std) =>
        upsertOpportunityFromStandard(repos, std, {
          reviewStatus: "approved",
          isListed: true,
          sourceSystem: sourceSystemOf(std.id) ?? undefined,
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
