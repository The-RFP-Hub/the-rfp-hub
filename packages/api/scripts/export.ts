/**
 * Open-data export: publish the public dataset as JSON + CSV and record a `dataset_snapshots`
 * row per format. Exports are released under CC0-1.0 (marked in the JSON envelope and in a
 * LICENSE sidecar published alongside the data).
 *
 * Every run publishes five objects:
 *   opportunities-<YYYY-MM-DD>.json / .csv  — the immutable dated archive for that night
 *   latest.json / latest.csv                — stable URLs a consumer can hard-code
 *   LICENSE                                 — the CC0 rights sidecar
 *
 * WHERE they land is the sink's business (see scripts/upload.ts): a local directory by default,
 * an S3 bucket when S3_BUCKET is set. `dataset_snapshots.url` records whatever URL the sink
 * reports — a public/CDN URL, an `s3://` URI, or the local path. The dated archive is published
 * immutable and the moving aliases short-lived (CACHE_CONTROL in upload.ts), so a CDN in front of
 * the bucket cannot serve yesterday's `latest.*` for its own default TTL.
 *
 * A run below EXPORT_MIN_COUNT (default 100) publishes NOTHING and exits non-zero. An empty or
 * half-loaded database would otherwise quietly overwrite `latest.*` with a header-only CSV.
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
const LICENSE_NOTICE = `SPDX-License-Identifier: CC0-1.0

To the extent possible under law, the publisher of this dataset has waived all
copyright and related or neighboring rights to it. This dataset is released under
the Creative Commons CC0 1.0 Universal Public Domain Dedication.

https://creativecommons.org/publicdomain/zero/1.0/legalcode
`;

const JSON_TYPE = "application/json; charset=utf-8";
const CSV_TYPE = "text/csv; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One published object and the URL recorded for it. */
export interface ExportArtifact {
  key: string;
  url: string;
}

export interface ExportResult {
  count: number;
  /** UTC date stamp used in the dated keys. */
  date: string;
  /** Human-readable destination, for logs. */
  destination: string;
  /** Every object published, in write order. */
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
        `floor of ${minCount}. Nothing was written or uploaded — the previous export is untouched.`,
        "Check the seed run, or lower EXPORT_MIN_COUNT if a smaller dataset is expected.",
      ].join(" "),
    );
    this.name = "ExportFloorError";
  }
}

/**
 * Raised when `latest.json` landed but `latest.csv` did not (or vice versa). An object store gives
 * no cross-object atomicity, so the two stable aliases CAN end up describing different datasets —
 * this makes that an explicit, actionable failure instead of a mismatch a consumer discovers by
 * diffing the two formats a day later.
 */
export class LatestAliasMismatchError extends Error {
  constructor(
    readonly published: string,
    readonly failed: string,
    readonly date: string,
    override readonly cause: unknown,
  ) {
    super(
      [
        `published ${published} but FAILED to publish ${failed}: the two stable aliases now`,
        `describe different datasets (${published} is ${date}, ${failed} is the previous run).`,
        `Re-run the export to converge them — the dated archive for ${date} is already complete.`,
      ].join(" "),
    );
    this.name = "LatestAliasMismatchError";
  }
}

function resolveMinCount(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.EXPORT_MIN_COUNT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_COUNT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`EXPORT_MIN_COUNT must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
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
  // Floor first: assert BEFORE anything is serialized, written or uploaded, so a short run can
  // never clobber `latest.*` or leave a truncated archive behind.
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

  // Dated archive first, then the stable aliases: a crash before the first `latest.*` put leaves
  // both aliases pointing at the last COMPLETE dataset rather than a partially-written one. The
  // two `latest.*` puts are still two independent objects — see LatestAliasMismatchError below for
  // the one window an object store cannot close.
  const artifacts: ExportArtifact[] = [];
  const publish = async (
    key: string,
    body: string,
    contentType: string,
    cacheControl: string,
  ): Promise<string> => {
    const url = await sink.put(key, body, contentType, cacheControl);
    artifacts.push({ key, url });
    return url;
  };

  const dated = CACHE_CONTROL.immutable;
  const moving = CACHE_CONTROL.mutable;
  const jsonUrl = await publish(`opportunities-${date}.json`, json, JSON_TYPE, dated);
  const csvUrl = await publish(`opportunities-${date}.csv`, csv, CSV_TYPE, dated);
  await publish("latest.json", json, JSON_TYPE, moving);
  try {
    await publish("latest.csv", csv, CSV_TYPE, moving);
  } catch (err) {
    // latest.json is already live and latest.csv is not: report the divergence by name rather than
    // letting a bare PutObject error hide which of the two advertised URLs is now stale.
    throw new LatestAliasMismatchError("latest.json", "latest.csv", date, err);
  }
  // CC0 rights sidecar: makes a bare exported file set machine-detectable as CC0 (SPDX + licensee)
  // even without the JSON envelope. Not hashed into dataset_snapshots (those track data files only).
  await publish("LICENSE", LICENSE_NOTICE, TEXT_TYPE, moving);

  // Snapshots point at the DATED objects — they are the immutable record of that run; `latest.*`
  // is an alias that moves.
  await db.insert(datasetSnapshots).values([
    {
      format: "json",
      entryCount: items.length,
      url: jsonUrl,
      sha256: sha256(json),
      specVersion: SPEC_VERSION,
    },
    {
      format: "csv",
      entryCount: items.length,
      url: csvUrl,
      sha256: sha256(csv),
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
      const expected = err instanceof ExportFloorError || err instanceof LatestAliasMismatchError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
