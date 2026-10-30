/**
 * THE STALENESS RULE ITSELF — pure, no DB, no HTTP, unit-tested.
 *
 * The staleness job (`services/jobs/staleness.service.ts`) is not the only thing that has to know
 * when an open listing will be closed for going quiet. A reviewer's "closing soon" list asks the
 * same question about the future, and the moment the two are answered by different code the list
 * starts promising a date the job does not keep. So the decision lives here once, the job calls
 * `stalenessClosureReason`, and the list calls `inactivityClosesAt`, which is the same rule solved
 * for the time at which it starts saying `inactive`.
 *
 * THE INACTIVITY CLOCK is `coalesce(last_seen_at, updated_at)`. It is refreshed by a matched source
 * check, a publisher write, a granted claim, a review approval and a reviewer's "confirm still
 * open" — never by the job, which deliberately leaves `updated_at` alone (see the job's header).
 */
import type { OpportunityRow } from "../../db/schema.js";
import { isPastDue, nextDeadlineAt } from "./deadlines.js";

/** Why an entry was closed. Recorded verbatim in the audit patch. */
export type StalenessReason = "past_due" | "inactive";

/** What the rule reads from a row. A `Pick` so the unit tests need no full row. */
export type StalenessFacts = Pick<OpportunityRow, "deadlines" | "lastSeenAt" | "updatedAt">;

const DAY_MS = 86_400_000;

/** The instant the inactivity clock is read from. */
export function inactivityClockOf(row: StalenessFacts): Date {
  return row.lastSeenAt ?? row.updatedAt;
}

/** `now - inactiveDays`: a clock older than this is inactive. */
export function inactiveBeforeOf(now: Date, inactiveDays: number): Date {
  return new Date(now.getTime() - inactiveDays * DAY_MS);
}

/**
 * The two rules, in the order the job applies them. `null` when the entry stays open.
 *
 * `next` is `nextDeadlineAt(row.deadlines, now)`, passed in because the job has already computed
 * it to keep the derived key honest.
 */
export function stalenessClosureReason(
  row: StalenessFacts,
  next: Date | null,
  now: Date,
  inactiveBefore: Date,
): StalenessReason | null {
  if (isPastDue(row.deadlines, now)) return "past_due";
  if (next !== null) return null;
  return inactivityClockOf(row).getTime() < inactiveBefore.getTime() ? "inactive" : null;
}

/**
 * The earliest instant at which `stalenessClosureReason` says `inactive` for this row as it is
 * stored now, or `null` when the inactivity pass is not what decides it:
 *
 *   - PAST DUE. The job closes it on its next run as `past_due`, and refreshing the inactivity clock
 *     would not change that, so it is not something a reviewer can keep open by confirming it;
 *   - A FUTURE FIXED DEADLINE. The inactivity pass never closes an entry that holds one.
 *
 * Solved from the same comparison the job makes: `clock < now - days` ⇔ `clock + days < now`, so
 * the job closes the row on its first run strictly after the returned instant. A returned instant in
 * the past means the next run closes it.
 */
export function inactivityClosesAt(
  row: StalenessFacts,
  now: Date,
  inactiveDays: number,
): Date | null {
  if (isPastDue(row.deadlines, now)) return null;
  if (nextDeadlineAt(row.deadlines, now) !== null) return null;
  return new Date(inactivityClockOf(row).getTime() + inactiveDays * DAY_MS);
}
