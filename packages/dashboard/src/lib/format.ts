/**
 * Pure presentation helpers. No React, no network, no `Date.now()` where it can be avoided — so
 * they are unit-testable, and so a chart's geometry can be asserted without a DOM.
 */
import type { DuplicateCheckStatus, InsightsPoint } from "./types";

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

/** Thousands separators without a locale — the same string on every machine, including in tests. */
export function formatCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatSimilarity(similarity: number | null): string {
  if (similarity === null) return "similarity unknown";
  return `${Math.round(similarity * 100)}% similar`;
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
