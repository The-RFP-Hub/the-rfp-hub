/**
 * Open-data export: write the public dataset as JSON + CSV under ./exports and record a
 * `dataset_snapshots` row per format. Exports are released under CC0-1.0, marked both in the JSON
 * envelope and in a LICENSE sidecar written alongside the data.
 *
 * Every run writes five files, in this order:
 *
 *   LICENSE                             the CC0 rights sidecar, written FIRST so no data file is
 *                                       ever readable without its rights notice beside it
 *   opportunities-<date>-<digest>.json  this run's archive, named after a prefix of the sha256
 *   opportunities-<date>-<digest>.csv   of its own bytes
 *   latest.json                         stable names a consumer can hard-code, written LAST so
 *   latest.csv                          they never name a half-written dataset
 *
 * `dataset_snapshots` records the ARCHIVE names — the per-run record — with the sha256 of the
 * bytes stored under them, never the aliases, which move.
 *
 * A run below EXPORT_MIN_COUNT (default 100) writes NOTHING and exits non-zero: an empty or
 * half-loaded database would otherwise quietly replace `latest.*` with a header-only CSV.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { datasetSnapshots, opportunities } from "../src/db/schema.js";
import { toStandard } from "../src/modules/mappers/opportunity.mapper.js";
import { toCsv } from "./csv.js";

const OUT_DIR = "exports";
const LICENSE = "CC0-1.0";
const DEFAULT_MIN_COUNT = 100;
const LICENSE_NOTICE = `SPDX-License-Identifier: CC0-1.0

To the extent possible under law, the publisher of this dataset has waived all
copyright and related or neighboring rights to it. This dataset is released under
the Creative Commons CC0 1.0 Universal Public Domain Dedication.

https://creativecommons.org/publicdomain/zero/1.0/legalcode
`;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Archive names carry a prefix of the sha256 of their own bytes, so one name can never designate
 * two different datasets: a second run on the same UTC day — a re-run after a partial failure, say
 * — writes its own archive instead of overwriting the first. A re-run over unchanged data rewrites
 * byte-identical content under the same name, which is a no-op. The date stays the readable prefix.
 */
const archiveName = (date: string, digest: string, ext: string): string =>
  `opportunities-${date}-${digest.slice(0, 12)}.${ext}`;

/** One written file: the name it was written under, and the path it was written to. */
export interface ExportArtifact {
  name: string;
  path: string;
}

export interface ExportResult {
  count: number;
  /** UTC date stamp used in the archive names. */
  date: string;
  /** Directory the files were written to. */
  outDir: string;
  /** Every file written, in write order. */
  artifacts: ExportArtifact[];
}

export interface ExportOptions {
  /** Where to write. Defaults to `./exports`. */
  outDir?: string;
  /** Minimum live entries required to publish. Defaults to EXPORT_MIN_COUNT, then 100. */
  minCount?: number;
}

/** Thrown when the dataset is too small to publish. Nothing has been written when it is raised. */
export class ExportFloorError extends Error {
  constructor(
    readonly count: number,
    readonly minCount: number,
  ) {
    super(
      [
        `refusing to publish: ${count} live opportunit${count === 1 ? "y" : "ies"} is below the`,
        `floor of ${minCount}. Nothing was written — the previous export is untouched.`,
        "Check the seed run, or lower EXPORT_MIN_COUNT if a smaller dataset is expected.",
      ].join(" "),
    );
    this.name = "ExportFloorError";
  }
}

/**
 * Thrown when a run fails part-way through writing. Nothing makes five files land atomically, so a
 * partial file set is a state a run really can end in — this names which files were written and
 * which one was not, instead of leaving that to be inferred from a bare write error. No
 * `dataset_snapshots` row is recorded for such a run, so the database never claims a publication
 * that did not happen.
 */
export class ExportWriteError extends Error {
  constructor(
    readonly failed: string,
    readonly written: readonly string[],
    override readonly cause: unknown,
  ) {
    super(
      [
        `failed to write ${failed} after writing`,
        written.length > 0 ? written.join(", ") : "nothing",
        "— this run's file set is incomplete and no snapshot row was recorded.",
        "Re-run the export to complete it.",
      ].join(" "),
    );
    this.name = "ExportWriteError";
  }
}

function assertFloor(value: number, source: string, raw = String(value)): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${source} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * The floor, from the explicit option or from EXPORT_MIN_COUNT. BOTH paths are validated here: a
 * caller passing a negative or fractional minimum would otherwise slip past the check the
 * environment variable is held to, and disable the very guard the floor exists to be.
 */
function resolveMinCount(explicit: number | undefined): number {
  if (explicit !== undefined) return assertFloor(explicit, "minCount");
  const raw = process.env.EXPORT_MIN_COUNT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_COUNT;
  return assertFloor(Number(raw), "EXPORT_MIN_COUNT", raw);
}

/** Run the export. Does not close the pool (caller's job). */
export async function runExport(options: ExportOptions = {}): Promise<ExportResult> {
  const minCount = resolveMinCount(options.minCount);
  const outDir = options.outDir ?? OUT_DIR;

  const rows = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true)))
    .orderBy(asc(opportunities.publicId));

  const items = rows.map(toStandard);
  // Floor first: assert BEFORE anything is serialized or written, so a short run can never clobber
  // `latest.*` or leave a truncated archive behind.
  if (items.length < minCount) throw new ExportFloorError(items.length, minCount);

  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);

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
  const jsonDigest = sha256(json);
  const csvDigest = sha256(csv);

  await mkdir(outDir, { recursive: true });
  const artifacts: ExportArtifact[] = [];
  const write = async (name: string, body: string): Promise<string> => {
    const path = join(outDir, name);
    try {
      await writeFile(path, body);
    } catch (err) {
      throw new ExportWriteError(
        name,
        artifacts.map((a) => a.name),
        err,
      );
    }
    artifacts.push({ name, path });
    return path;
  };

  // Rights sidecar first: its content is constant, so re-writing it every run is idempotent, and
  // going first means no data file is ever readable without it. Then the archive, then the aliases
  // that point at it — a run that dies part-way leaves `latest.*` on the last COMPLETE dataset
  // rather than on a partially-written one.
  await write("LICENSE", LICENSE_NOTICE);
  const jsonPath = await write(archiveName(date, jsonDigest, "json"), json);
  const csvPath = await write(archiveName(date, csvDigest, "csv"), csv);
  await write("latest.json", json);
  await write("latest.csv", csv);

  await db.insert(datasetSnapshots).values([
    {
      format: "json",
      entryCount: items.length,
      url: jsonPath,
      sha256: jsonDigest,
      specVersion: SPEC_VERSION,
    },
    {
      format: "csv",
      entryCount: items.length,
      url: csvPath,
      sha256: csvDigest,
      specVersion: SPEC_VERSION,
    },
  ]);

  return { count: items.length, date, outDir, artifacts };
}

// CLI entry — skipped under Vitest so tests can import runExport without side effects.
if (!process.env.VITEST) {
  runExport()
    .then(({ count, artifacts }) => {
      const written = artifacts.map(({ path }) => `  ${path}`).join("\n");
      console.log(`✓ exported ${count} opportunities\n${written}`);
    })
    .catch((err) => {
      const expected = err instanceof ExportFloorError || err instanceof ExportWriteError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
