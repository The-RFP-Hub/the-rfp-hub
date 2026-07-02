/**
 * Open-data export (DEV-448, local slice): dump the public dataset to JSON + CSV under ./exports
 * and record a `dataset_snapshots` row per file. Cloud bucket upload + nightly cron land at deploy.
 * Exports are released under CC0-1.0 (marked in the JSON envelope).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_VERSION } from "@rfp-hub/standard";
import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../src/db/schema.js";
import { toStandard } from "../src/modules/mappers/opportunity.mapper.js";
import { toCsv } from "./csv.js";

const OUT_DIR = "exports";
const LICENSE = "CC0-1.0";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Run the export; returns the written paths + entry count. Does not close the pool (caller's job). */
export async function runExport(outDir: string = OUT_DIR): Promise<{
  jsonPath: string;
  csvPath: string;
  count: number;
}> {
  const rows = await db
    .select()
    .from(opportunities)
    .innerJoin(organizations, eq(opportunities.organizationId, organizations.id))
    .where(and(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true)))
    .orderBy(asc(opportunities.publicId));

  const items = rows.map((r) => toStandard(r.opportunities, r.organizations));
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);

  await mkdir(outDir, { recursive: true });
  const json = `${JSON.stringify(
    {
      specVersion: SPEC_VERSION,
      license: LICENSE,
      generatedAt,
      count: items.length,
      opportunities: items,
    },
    null,
    2,
  )}\n`;
  const csv = toCsv(items);

  const jsonPath = join(outDir, `opportunities-${date}.json`);
  const csvPath = join(outDir, `opportunities-${date}.csv`);
  await writeFile(jsonPath, json);
  await writeFile(csvPath, csv);

  await db.insert(datasetSnapshots).values([
    {
      format: "json",
      entryCount: items.length,
      url: jsonPath,
      sha256: sha256(json),
      specVersion: SPEC_VERSION,
    },
    {
      format: "csv",
      entryCount: items.length,
      url: csvPath,
      sha256: sha256(csv),
      specVersion: SPEC_VERSION,
    },
  ]);

  return { jsonPath, csvPath, count: items.length };
}

// CLI entry — skipped under Vitest so tests can import runExport without side effects.
if (!process.env.VITEST) {
  runExport()
    .then(({ count, jsonPath, csvPath }) => {
      console.log(`✓ exported ${count} opportunities → ${jsonPath}, ${csvPath}`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
