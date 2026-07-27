/**
 * PURE deadline derivations over the Standard's `deadlines[]` array — no DB/HTTP, unit-tested.
 *
 * The re-cut removed the single `closesAt` scalar and replaced it with an array of
 * `{type: 'fixed' | 'rolling', date?, label?}` entries. Nothing sortable survived that change, so
 * the API derives two things from the array:
 *
 * 1. **`nextDeadlineAt`** — the earliest FUTURE `fixed` deadline. This is the sort/filter key that
 *    replaces `closesAt`. It is NULL for a record whose deadlines are rolling-only, all in the
 *    past, or absent. Denormalized into `opportunities.next_deadline_at` on every write so it can
 *    be indexed (see db/schema.ts); recompute it whenever `deadlines` changes.
 * 2. **`isPastDue`** — the auto-close/staleness predicate that replaces `closesAt < now()`:
 *    the latest `fixed` deadline is in the past AND the record carries NO `rolling` entry.
 *    A rolling program never auto-closes, however old its fixed dates are.
 *
 * Deliberately NOT label-aware: `nextDeadlineAt` answers "what is the next date on this record",
 * which is the question a deadline sort asks. Anything that needs "the application deadline"
 * specifically must select by label per the Standard (`registries/deadline-labels.json`).
 */
import type { Deadline } from "@the-rfp-hub/standard";

/** Parse a deadline's `date` to a Date, or null when absent/unparseable. */
function dateOf(d: Deadline): Date | null {
  if (d.date === undefined || d.date === null) return null;
  const parsed = new Date(d.date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Every parseable `fixed` date on the record, ascending. */
function fixedDates(deadlines: Deadline[] | null | undefined): Date[] {
  if (!Array.isArray(deadlines)) return [];
  return deadlines
    .filter((d) => d?.type === "fixed")
    .map(dateOf)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Whether the record accepts applications on a rolling basis. */
export function hasRollingDeadline(deadlines: Deadline[] | null | undefined): boolean {
  return Array.isArray(deadlines) && deadlines.some((d) => d?.type === "rolling");
}

/**
 * The earliest `fixed` deadline strictly after `now`, or null.
 *
 * Null for: no deadlines, rolling-only, and all-fixed-dates-in-the-past. Those records sort LAST
 * on a `nextDeadlineAt` sort (NULLS LAST in both directions) and are excluded from the
 * deadline-window filters — a documented consequence of there being no date to compare.
 */
export function nextDeadlineAt(
  deadlines: Deadline[] | null | undefined,
  now: Date = new Date(),
): Date | null {
  return fixedDates(deadlines).find((d) => d.getTime() > now.getTime()) ?? null;
}

/** The latest `fixed` deadline on the record, or null when it has none. */
export function latestFixedDeadlineAt(deadlines: Deadline[] | null | undefined): Date | null {
  const dates = fixedDates(deadlines);
  return dates.length ? (dates[dates.length - 1] as Date) : null;
}

/**
 * Auto-close / staleness predicate, re-keyed off `deadlines[]`.
 *
 * True when the LATEST fixed deadline is in the past AND there is no rolling entry. Rolling
 * programs are never past due; a record with no fixed deadline at all is never past due either.
 * This is the condition a staleness job (⏳ M3, see docs/data-model.md "Key flows") must use in
 * place of the removed `closes_at < now()`.
 */
export function isPastDue(
  deadlines: Deadline[] | null | undefined,
  now: Date = new Date(),
): boolean {
  if (hasRollingDeadline(deadlines)) return false;
  const latest = latestFixedDeadlineAt(deadlines);
  return latest !== null && latest.getTime() < now.getTime();
}
