/**
 * Open-data export: publish the public dataset as JSON + CSV and record a `dataset_snapshots` row
 * per format. Exports are released under CC0-1.0, marked both in the JSON envelope and in a
 * LICENSE sidecar published alongside the data.
 *
 * Every run publishes five objects, in this order:
 *
 *   LICENSE                             the CC0 rights sidecar, FIRST so no data object is ever
 *                                       readable without its rights notice beside it
 *   opportunities-<date>-<digest>.json  this run's archive, named after a prefix of the sha256
 *   opportunities-<date>-<digest>.csv   of its own bytes
 *   latest.json                         stable keys a consumer can hard-code, LAST so they never
 *   latest.csv                          name a half-written dataset
 *
 * WHERE they land is the sink's business (see scripts/upload.ts): a local directory by default, an
 * S3 bucket when S3_BUCKET is set. `dataset_snapshots` records the ARCHIVE keys — the per-run
 * record — with the sha256 of the bytes stored under them, never the aliases, which move, and the
 * URL is whatever the sink reports: a public/CDN URL, an `s3://` URI, or a local path.
 *
 * A run below EXPORT_MIN_COUNT (default 100) publishes NOTHING and exits non-zero: an empty or
 * half-loaded database would otherwise quietly replace `latest.*` with a header-only CSV.
 */
import { createHash } from "node:crypto";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { datasetSnapshots, opportunities } from "../src/db/schema.js";
import { toStandard } from "../src/modules/mappers/opportunity.mapper.js";
import { toCsv } from "./csv.js";
import { CACHE_CONTROL, type ExportSink, createSinkFromEnv } from "./upload.js";

const OUT_DIR = "exports";
const LICENSE = "CC0-1.0";
const DEFAULT_MIN_COUNT = 100;
const JSON_TYPE = "application/json; charset=utf-8";
const CSV_TYPE = "text/csv; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
const LICENSE_NOTICE = `SPDX-License-Identifier: CC0-1.0

To the extent possible under law, the publisher of this dataset has waived all
copyright and related or neighboring rights to it. This dataset is released under
the Creative Commons CC0 1.0 Universal Public Domain Dedication.

https://creativecommons.org/publicdomain/zero/1.0/legalcode
`;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Archive keys carry a prefix of the sha256 of their own bytes, so one key can never designate two
 * different datasets: a second run on the same UTC day — a re-run after a partial failure, say —
 * writes its own archive instead of overwriting the first. A re-run over unchanged data rewrites
 * byte-identical content under the same key, which is a no-op. The date stays the readable prefix.
 * This is also what makes CACHE_CONTROL.immutable an honest header for these objects.
 */
const archiveKey = (date: string, digest: string, ext: string): string =>
  `opportunities-${date}-${digest.slice(0, 12)}.${ext}`;

/** One published object: the key it went under, and the URL recorded for it. */
export interface ExportArtifact {
  key: string;
  url: string;
}

export interface ExportResult {
  count: number;
  /** UTC date stamp used in the archive keys. */
  date: string;
  /** Human-readable destination, for logs. */
  destination: string;
  /** Every object published, in publish order. */
  artifacts: ExportArtifact[];
}

export interface ExportOptions {
  /** Directory for the default local sink. Ignored when a `sink` is supplied. */
  outDir?: string;
  /** Where to publish. Defaults to the env-selected sink (S3 when S3_BUCKET is set). */
  sink?: ExportSink;
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
 * Thrown when a run fails part-way through publishing. An object store gives no cross-object
 * atomicity and neither does a directory, so a partial file set is a state a run really can end in
 * — this names which objects were written and which one was not, instead of leaving that to be
 * inferred from a bare PutObject or write error. No `dataset_snapshots` row is recorded for such a
 * run, so the database never claims a publication that did not happen.
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
  const sink = options.sink ?? createSinkFromEnv(options.outDir ?? OUT_DIR);

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

  const artifacts: ExportArtifact[] = [];
  const publish = async (
    key: string,
    body: string,
    contentType: string,
    cacheControl: string,
  ): Promise<string> => {
    let url: string;
    try {
      url = await sink.put(key, body, contentType, cacheControl);
    } catch (err) {
      throw new ExportWriteError(
        key,
        artifacts.map((a) => a.key),
        err,
      );
    }
    artifacts.push({ key, url });
    return url;
  };

  // Rights sidecar first: its content is constant, so re-publishing it every run is idempotent, and
  // going first means no data object is ever readable without it. Then the archive, then the
  // aliases that point at it — a run that dies part-way leaves `latest.*` on the last COMPLETE
  // dataset rather than on a partially-written one. Only the archive keys are content-addressed,
  // so only they get the immutable header.
  const fixed = CACHE_CONTROL.immutable;
  const moving = CACHE_CONTROL.mutable;
  await publish("LICENSE", LICENSE_NOTICE, TEXT_TYPE, moving);
  const jsonUrl = await publish(archiveKey(date, jsonDigest, "json"), json, JSON_TYPE, fixed);
  const csvUrl = await publish(archiveKey(date, csvDigest, "csv"), csv, CSV_TYPE, fixed);
  await publish("latest.json", json, JSON_TYPE, moving);
  await publish("latest.csv", csv, CSV_TYPE, moving);

  await db.insert(datasetSnapshots).values([
    {
      format: "json",
      entryCount: items.length,
      url: jsonUrl,
      sha256: jsonDigest,
      specVersion: SPEC_VERSION,
    },
    {
      format: "csv",
      entryCount: items.length,
      url: csvUrl,
      sha256: csvDigest,
      specVersion: SPEC_VERSION,
    },
  ]);

  return { count: items.length, date, destination: sink.description, artifacts };
}

// CLI entry — skipped under Vitest so tests can import runExport without side effects.
if (!process.env.VITEST) {
  runExport()
    .then(({ count, destination, artifacts }) => {
      const published = artifacts.map(({ url }) => `  ${url}`).join("\n");
      console.log(`✓ exported ${count} opportunities → ${destination}\n${published}`);
    })
    .catch((err) => {
      const expected = err instanceof ExportFloorError || err instanceof ExportWriteError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
