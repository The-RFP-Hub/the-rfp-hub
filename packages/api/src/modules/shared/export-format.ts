/**
 * THE FORMAT: the one serialization of the public dataset, shared by everything that publishes it.
 *
 * Three things live here and nowhere else — the published ORDER, the JSON envelope, and the CSV
 * projection. Everything that hands the dataset to a consumer goes through them:
 *
 *   scripts/export-writer.ts        the nightly snapshot's six files (this module's output, on disk)
 *   modules/routes/export/          the live download endpoints (this module's output, over HTTP)
 *
 * That is the point of the module. A snapshot fetched from `latest.json` and a download taken from
 * `/v1/export/opportunities.json` describe the same records in the same bytes, per record, so a
 * consumer can treat the two interchangeably and a diff between them means the DATA moved — never
 * that two serializers drifted. The `generatedAt` stamp and the file-publication machinery (digests,
 * archive names, the CC0 sidecar, the floor, the manifest) are the writer's; they are not here,
 * because the live endpoint publishes no files and must not inherit the floor that protects them.
 *
 * It lives under `src/` rather than beside the writer because the direction of the dependency has to
 * be `scripts/ → src/`: the server cannot import a script (nothing on a request path should be able
 * to pull in `node:fs` and a CLI entry point), while a script importing the server's shared modules
 * is exactly what the other export helpers already do.
 *
 * Pure: no database, no filesystem, no clock. `generatedAt` is passed IN.
 */
import { type Opportunity, SPEC_VERSION } from "@the-rfp-hub/standard";
import { nextDeadlineAt } from "./deadlines.js";

/** The dataset's licence, stated in the JSON envelope and in the writer's CC0 sidecar. */
export const EXPORT_LICENSE = "CC0-1.0";

/**
 * Flat columns for the CC0 tabular export.
 *
 * The re-cut removed the two scalars this used to lean on: `closesAt` (now `deadlines[]`) and
 * `source.url` (removed outright). CSV is a flat format, so the array is represented by the same
 * derived scalar the API sorts on — `nextDeadlineAt`, the earliest upcoming FIXED deadline — plus
 * a `rollingDeadline` boolean so a rolling program is distinguishable from one that simply has no
 * upcoming date. The full `deadlines[]` array is available in the JSON export.
 */
export const CSV_COLUMNS = [
  "id",
  "fundingType",
  "status",
  "title",
  "organization",
  "organizationSlug",
  "ecosystems",
  "categories",
  "currency",
  "minAward",
  "maxAward",
  "budget",
  "allocated",
  "opensAt",
  "nextDeadlineAt",
  "rollingDeadline",
  "applicationUrl",
] as const;

export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  // Neutralize spreadsheet formula injection from untrusted upstream text (title/org name, etc.):
  // a leading = + - @ tab or CR would otherwise execute as a formula in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(items: readonly Opportunity[]): string {
  const rows = items.map((o) => {
    // operatingOrganizations[0] is the primary/display organization (array order is semantic).
    const primary = o.operatingOrganizations?.[0];
    const next = nextDeadlineAt(o.deadlines);
    return [
      o.id,
      o.fundingType,
      o.status,
      o.title,
      primary?.name,
      primary?.slug,
      (o.ecosystems ?? []).join("|"),
      (o.categories ?? []).join("|"),
      o.fundingInfo?.currency,
      o.fundingInfo?.minAward,
      o.fundingInfo?.maxAward,
      o.fundingInfo?.budget,
      o.fundingInfo?.allocated,
      o.opensAt,
      next ? next.toISOString() : "",
      (o.deadlines ?? []).some((d) => d.deadlineType === "rolling"),
      o.applicationUrl,
    ]
      .map(csvCell)
      .join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}

/**
 * The published order: by `id`, ascending, compared by code unit — imposed HERE rather than left to
 * whichever source produced the records.
 *
 * Ordering is part of the published format, not a side effect of how the records were obtained.
 * Sorting here makes the bytes a function of the DATA alone: a database orders by its own collation
 * (which is a property of the server, so two deployments of the same data could publish two
 * orders), and an API's list endpoint has no `id` sort key at all. Every source hands its records
 * to this comparison instead, and the same records publish the same file either way.
 */
const byId = (a: Opportunity, b: Opportunity): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The records in published order. Returns a new array; the input is never mutated. */
export function orderForExport(items: readonly Opportunity[]): Opportunity[] {
  return [...items].sort(byId);
}

/** The JSON export's envelope — the shape `latest.json` and the live JSON download both carry. */
export interface ExportEnvelope {
  specVersion: string;
  license: string;
  /** When this particular representation was produced. The one field that is NOT data. */
  generatedAt: string;
  count: number;
  opportunities: readonly Opportunity[];
}

/**
 * The JSON export, exactly as published: the envelope, indented two spaces, newline-terminated.
 *
 * `items` must already be in published order (`orderForExport`) — taking ordered records rather
 * than sorting again keeps a caller that needs both formats from sorting twice, and makes the
 * ordering a visible step at every call site instead of a hidden one here.
 */
export function toExportJson(items: readonly Opportunity[], generatedAt: string): string {
  const envelope: ExportEnvelope = {
    specVersion: SPEC_VERSION,
    license: EXPORT_LICENSE,
    generatedAt,
    count: items.length,
    opportunities: items,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * A canonical serialization of the DATA alone — ordered records, no envelope, no `generatedAt`, no
 * indentation. Never sent to anyone: it exists to be hashed.
 *
 * The live JSON download stamps every response with the current time, so its bytes differ between
 * two requests that returned identical records. Hashing the BODY would therefore produce a
 * validator that changes on every request and never yields a 304 — so the JSON route derives its
 * entity-tag from this instead, and the tag moves when, and only when, the dataset does. (The CSV
 * has no timestamp in it, so its body already is a pure function of the data and it hashes its own
 * bytes.)
 */
export function datasetIdentity(items: readonly Opportunity[]): string {
  return JSON.stringify(items);
}
