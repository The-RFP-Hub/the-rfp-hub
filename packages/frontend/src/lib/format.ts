/**
 * Pure presentation helpers. No React, no network, no `Date.now()` where it can be avoided — so
 * they are unit-testable, and so a chart's geometry can be asserted without a DOM.
 */
import type { Deadline, DuplicateCheckStatus, Funding, InsightsPoint } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `2026-08-14` → `14 Aug`.
 *
 * Formatted from the STRING, never through `new Date(...).toLocaleDateString()`: the API's days are
 * UTC calendar days, and parsing one into a local-timezone Date shifts half the world's readers a
 * day backwards. An unparseable value is returned unchanged rather than rendered as "Invalid Date".
 */
export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return day;
  return `${Number(match[3])} ${month}`;
}

/** An RFC 3339 instant as a readable UTC stamp. Same reasoning: UTC in, UTC out. */
export function formatInstant(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const day = formatDay(parsed.toISOString().slice(0, 10));
  return `${day} ${parsed.toISOString().slice(11, 16)} UTC`;
}

/** An RFC 3339 instant as a plain, human-readable UTC calendar date. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`;
}

/** Thousands separators without a locale — the same string on every machine, including in tests. */
export function formatCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatSimilarity(similarity: number | null): string {
  if (similarity === null) return "similarity unknown";
  return `${Math.round(similarity * 100)}% similar`;
}

/**
 * The API's `matchedOn` labels as reader-facing chips.
 *
 * A LOOKUP WITH A FALLBACK, not a switch: `matchedOn` is an open enum on a published component, so
 * a label this build has never heard of must still render as itself rather than vanish or crash.
 * An empty array means the pair predates recorded reasons and gets no chips at all — deliberately
 * not a "no reasons" chip, which would read as a finding about the pair rather than about its age.
 */
const MATCH_REASON_LABELS: Record<string, string> = {
  lexical: "similar wording",
  // Never "contains" or "copy of": the underlying number is cosine corrected by a length ratio —
  // an estimate of shared vocabulary, not a containment proof.
  overlap: "shortened re-listing",
  application_url: "same application link",
  operating_org: "same organization",
};

export function formatMatchReasons(matchedOn: string[] | undefined): string[] {
  return (matchedOn ?? []).map((reason) => MATCH_REASON_LABELS[reason] ?? reason);
}

/**
 * A monetary amount in the document's own currency, or null when there is nothing to show.
 *
 * Grouped with the same locale-free separator as `formatCount`, and NEVER converted or rounded: the
 * Standard's amounts are major units in a currency the publisher named, and a directory that turned
 * "1000 OP" into "$1,000" would be inventing an exchange rate. The currency is publisher-supplied
 * text and is rendered as text, like every other string that arrives from a record.
 */
export function formatAmount(
  value: number | null | undefined,
  currency?: string | null,
): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const [whole = "0", fraction] = String(value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rendered = fraction ? `${grouped}.${fraction}` : grouped;
  const unit = currency?.trim();
  return unit ? `${rendered} ${unit}` : rendered;
}

/**
 * The funding envelope as one line, or null when the publisher stated nothing.
 *
 * The per-award range is preferred over the program budget because it is the number an applicant
 * is deciding on. Absent both, null — an empty envelope is shown as nothing rather than as a zero.
 */
export function describeAward(funding: Funding | null | undefined): string | null {
  if (!funding) return null;
  const min = formatAmount(funding.minAward);
  const max = formatAmount(funding.maxAward);
  const unit = funding.currency?.trim();
  const suffix = unit ? ` ${unit}` : "";
  if (min && max) return `${min}–${max}${suffix} per award`;
  if (max) return `Up to ${max}${suffix} per award`;
  if (min) return `From ${min}${suffix} per award`;
  const budget = formatAmount(funding.budget);
  if (budget) return `${budget}${suffix} program budget`;
  return null;
}

/** Every parseable `fixed` date on a record, ascending. Mirrors the API's own derivation. */
function fixedDeadlines(deadlines: readonly Deadline[] | null | undefined): Deadline[] {
  if (!Array.isArray(deadlines)) return [];
  return deadlines
    .filter(
      (entry) => entry?.deadlineType === "fixed" && !Number.isNaN(Date.parse(entry.date ?? "")),
    )
    .sort((a, b) => Date.parse(a.date ?? "") - Date.parse(b.date ?? ""));
}

/** Whether the record accepts applications on a rolling basis. */
export function hasRollingDeadline(deadlines: readonly Deadline[] | null | undefined): boolean {
  return Array.isArray(deadlines) && deadlines.some((entry) => entry?.deadlineType === "rolling");
}

/**
 * The earliest `fixed` deadline strictly after `now`, or null.
 *
 * The same derivation the API sorts and filters on (`nextDeadlineAt`), repeated here rather than
 * taken from the payload because the payload does not carry it: the list serves `deadlines[]`, and
 * the derived key is a database column the Standard object never names. Deliberately not
 * label-aware — this answers "what is the next date on this record", which is the question a
 * deadline column asks; selecting "the application deadline" specifically means selecting by label.
 */
export function nextFixedDeadline(
  deadlines: readonly Deadline[] | null | undefined,
  now: Date = new Date(),
): Deadline | null {
  return (
    fixedDeadlines(deadlines).find((entry) => Date.parse(entry.date ?? "") > now.getTime()) ?? null
  );
}

/**
 * The deadline column, as a phrase.
 *
 * Four distinct answers, because collapsing them loses the one a reader needs: a date, an open
 * rolling window, a record whose dates have all passed, and a record that states no deadline at all.
 */
export function describeDeadline(
  deadlines: readonly Deadline[] | null | undefined,
  now: Date = new Date(),
): string {
  const next = nextFixedDeadline(deadlines, now);
  if (next) return formatInstant(next.date);
  if (hasRollingDeadline(deadlines)) return "Rolling";
  if (fixedDeadlines(deadlines).length > 0) return "No upcoming deadline";
  return "—";
}

/** The compact directory deadline: the same four states, with a calendar date instead of a time. */
export function describeDirectoryDeadline(
  deadlines: readonly Deadline[] | null | undefined,
  now: Date = new Date(),
): string {
  const next = nextFixedDeadline(deadlines, now);
  if (next) return formatDate(next.date);
  if (hasRollingDeadline(deadlines)) return "Rolling";
  if (fixedDeadlines(deadlines).length > 0) return "No upcoming deadline";
  return "—";
}

/** `fixed` / `rolling` and the publisher's label, as one phrase for a deadlines table row. */
export function describeDeadlineEntry(entry: Deadline): string {
  return entry.deadlineType === "rolling" ? "Rolling" : formatInstant(entry.date);
}

export interface Bar {
  /** The datum's own label, kept alongside the geometry so a chart never re-derives it. */
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarGeometry {
  bars: Bar[];
  /** The value the tallest bar represents. Always ≥ 1, so an all-zero series draws a flat floor. */
  max: number;
}

/**
 * Lay out a bar chart.
 *
 * Kept out of the component because the interesting part is arithmetic, not markup: an all-zero
 * window (the common case for a new listing) must not divide by zero, and a one-day window must not
 * produce a bar of infinite width. Both are asserted in the unit tests.
 */
export function barGeometry(
  points: readonly { day: string; value: number }[],
  width: number,
  height: number,
): BarGeometry {
  const max = Math.max(1, ...points.map((point) => point.value));
  const slot = points.length > 0 ? width / points.length : width;
  const barWidth = Math.max(1, slot * 0.7);
  const bars = points.map((point, index) => {
    const barHeight = (point.value / max) * height;
    return {
      label: point.day,
      value: point.value,
      x: index * slot + (slot - barWidth) / 2,
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
  return { bars, max };
}

/** The four counters of an insights series, projected onto one metric. */
export type InsightsMetric = "listViews" | "detailViews" | "sourceClicks" | "applyClicks";

export const METRIC_LABELS: Record<InsightsMetric, string> = {
  listViews: "List views",
  detailViews: "Detail views",
  sourceClicks: "Source clicks",
  applyClicks: "Apply clicks",
};

export function seriesFor(
  days: readonly InsightsPoint[],
  metric: InsightsMetric,
): { day: string; value: number }[] {
  return days.map((point) => ({ day: point.day, value: point[metric] }));
}

/**
 * The sentence for a submission's duplicate check.
 *
 * An empty `duplicates` array means "nothing similar" ONLY when the check actually ran. The other
 * two states have to say what did not happen, or a publisher reads silence as a clean result — the
 * exact misreading the API added `duplicateCheck` to prevent.
 */
export function describeDuplicateCheck(status: DuplicateCheckStatus, matches: number): string {
  if (status === "disabled") {
    return "Duplicate detection is switched off on this deployment, so this entry was not compared against anything.";
  }
  if (status === "unavailable") {
    return "The duplicate check could not run just now. This entry is queued for the nightly pass — it has not been compared yet.";
  }
  if (matches === 0) return "Checked against the published entries: nothing similar found.";
  return `Checked against the published entries: ${matches} possible match${matches === 1 ? "" : "es"} found.`;
}

/** How long a window the insights routes were asked for, as a phrase for the page heading. */
export function describeWindow(days: number): string {
  return days === 1 ? "today" : `the last ${days} days`;
}
