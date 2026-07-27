/**
 * Seed loader: ingest programs from an upstream funding-map registry API, map each to
 * the RFP Hub Standard, VALIDATE every record against the schema, and upsert only the ones that
 * pass (approved + listed). Target >=100 valid.
 *
 * Validation is not optional and not a flag: `gateForSeed` runs on every mapped record before
 * anything reaches the database, and each rejection is printed with its id and the rules it broke.
 * Pass `--strict` (or SEED_STRICT=1) to turn any rejection into a failed run.
 *
 * The source is deployment-specific — set SOURCE_API_URL (and optionally SOURCE_SYSTEM /
 * SOURCE_PROGRAM_URL_BASE); see .env-example. The Hub maps external data into the neutral Standard
 * and never couples to any source's internal schema.
 *
 * The upstream registry still speaks the PRE-RE-CUT vocabulary (`type`, a single organization, one
 * `deadline`, per-block date fields, `fundingMechanism`, `totalBudget`). `scripts/map-program.ts`
 * is where that conversion to the re-cut Standard lives, following the same rules the Standard's
 * own examples were regenerated with; everything downstream of it is already re-cut-shaped.
 */
import { randomUUID } from "node:crypto";
import type { Opportunity } from "@rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { config } from "../src/config.js";
import { pool } from "../src/db/client.js";
import { OpportunityService } from "../src/modules/services/opportunities/opportunity.service.js";
import { type RegistryProgram, mapProgram } from "./map-program.js";

const TARGET = Number(process.env.SEED_TARGET ?? 120);
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MIN_VALID = 100;
const INVOCATION_ID = randomUUID();

export interface RejectedRecord {
  id: string;
  errors: string[];
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

/** Hard floor on the seed: throw (non-zero exit via the top-level catch) if too few loaded. */
export function assertSeedContract(loaded: number, min = MIN_VALID): void {
  if (loaded < min) {
    throw new Error(
      `seed contract violated: only ${loaded} valid entries (< ${min}) — raise SEED_TARGET or check the source`,
    );
  }
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
  if (!config.sourceApiUrl) {
    throw new Error(
      "SOURCE_API_URL is not set — point it at an upstream funding-map registry API (see .env-example)",
    );
  }
  const mapOpts = {
    sourceSystem: config.sourceSystem,
    programUrlBase: config.sourceProgramUrlBase || undefined,
  };
  const strict = process.argv.includes("--strict") || process.env.SEED_STRICT === "1";
  console.log(
    `Seeding from ${config.sourceApiUrl} (target ${TARGET} valid${strict ? ", --strict" : ""})…`,
  );
  const seen = new Set<string>();
  const valid: Opportunity[] = [];
  const rejected: RejectedRecord[] = [];

  for (let page = 1; page <= MAX_PAGES && valid.length < TARGET; page++) {
    const { programs, hasNext } = await fetchPage(page);
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

    console.log(`  page ${page}: ${valid.length} valid, ${rejected.length} rejected`);
    if (!hasNext) break;
  }

  assertNoRejections(rejected, strict);

  const ctl = new OpportunityService();
  let loaded = 0;
  for (const std of valid) {
    await ctl.upsertFromStandard(std, {
      reviewStatus: "approved",
      isListed: true,
      sourceSystem: config.sourceSystem,
    });
    loaded++;
  }

  console.log(
    `✓ ${loaded} opportunities loaded, ${rejected.length} rejected (schema-invalid, listed above)`,
  );
  assertSeedContract(loaded);
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
