/** PURE CSV serialization for the open-data export — no DB/IO, unit-testable. */
import type { Opportunity } from "@the-rfp-hub/standard";
import { nextDeadlineAt } from "../src/modules/shared/deadlines.js";

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

export function toCsv(items: Opportunity[]): string {
  const rows = items.map((o) => {
    // sponsoringOrganizations[0] is the primary/display organization (array order is semantic).
    const primary = o.sponsoringOrganizations?.[0];
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
      o.funding?.currency,
      o.funding?.minAward,
      o.funding?.maxAward,
      o.funding?.budget,
      o.funding?.allocated,
      o.opensAt,
      next ? next.toISOString() : "",
      (o.deadlines ?? []).some((d) => d.type === "rolling"),
      o.applicationUrl,
    ]
      .map(csvCell)
      .join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}
