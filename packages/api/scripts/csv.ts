/** PURE CSV serialization for the open-data export — no DB/IO, unit-testable. */
import type { Opportunity } from "@rfp-hub/standard";

export const CSV_COLUMNS = [
  "id",
  "type",
  "status",
  "title",
  "organization",
  "organizationSlug",
  "ecosystems",
  "categories",
  "currency",
  "minAward",
  "maxAward",
  "totalBudget",
  "opensAt",
  "closesAt",
  "applicationUrl",
  "sourceUrl",
] as const;

export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  // Neutralize spreadsheet formula injection from untrusted upstream text (title/org name, etc.):
  // a leading = + - @ tab or CR would otherwise execute as a formula in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(items: Opportunity[]): string {
  const rows = items.map((o) =>
    [
      o.id,
      o.type,
      o.status,
      o.title,
      o.organization?.name,
      o.organization?.slug,
      (o.ecosystems ?? []).join("|"),
      (o.categories ?? []).join("|"),
      o.funding?.currency,
      o.funding?.minAward,
      o.funding?.maxAward,
      o.funding?.totalBudget,
      o.opensAt,
      o.closesAt,
      o.applicationUrl,
      o.source?.url,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}
