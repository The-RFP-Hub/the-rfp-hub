/**
 * Seed loader: ingest programs from an upstream funding-map registry API, map each to
 * the RFP Hub Standard, VALIDATE with rfphub-validate, and upsert the valid ones (approved +
 * listed). Invalid entries are skipped and counted (no silent truncation). Target >=100 valid.
 *
 * The source is deployment-specific — set SOURCE_API_URL (and optionally SOURCE_SYSTEM /
 * SOURCE_PROGRAM_URL_BASE); see .env-example. The Hub maps external data into the neutral Standard
 * and never couples to any source's internal schema.
 */
import { randomUUID } from "node:crypto";
import type { Opportunity } from "@rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { config } from "../src/config.js";
import { pool } from "../src/db/client.js";
import { OpportunityService } from "../src/modules/services/opportunities/opportunity.service.js";
import { type RegistryProgram, mapProgram } from "./map-program.js";

const TARGET = Number(process.env.SEED_TARGET ?? 120);
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MIN_VALID = 100;
const INVOCATION_ID = randomUUID();

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
  console.log(`Seeding from ${config.sourceApiUrl} (target ${TARGET} valid)…`);
  const seen = new Set<string>();
  const valid: Opportunity[] = [];
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES && valid.length < TARGET; page++) {
    const { programs, hasNext } = await fetchPage(page);
    if (programs.length === 0) break;
    for (const program of programs) {
      const std = mapProgram(program, mapOpts);
      if (seen.has(std.id)) continue;
      seen.add(std.id);
      if (validateOpportunity(std).valid) valid.push(std);
      else skipped++;
    }
    console.log(`  page ${page}: ${valid.length} valid, ${skipped} skipped`);
    if (!hasNext) break;
  }

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

  console.log(`✓ ${loaded} opportunities loaded, ${skipped} skipped (invalid)`);
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
