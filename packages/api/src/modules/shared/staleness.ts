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
import { hasRollingDeadline, isPastDue, latestFixedDeadlineAt } from "./deadlines.js";

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
 * `stalenessClosureReason` PROJECTED: where, on the time line, it first says `inactive` for this row
 * as it is stored now — or `null` when, from `now` on, it never will.
 *
 * The rule says `inactive` at time `t` exactly when all three hold (the comparisons are the job's
 * own: `isPastDue` uses `<`, `nextDeadlineAt` uses `>`, the clock test uses `<`):
 *
 *   1. not past due at `t`        — with a rolling entry, always; otherwise `t <= L`;
 *   2. no fixed deadline after `t` — `t >= L`, where `L` is the latest fixed date (none: always);
 *   3. `clock < t - days`          — `t > Q`, where `Q = clock + days`.
 *
 * So, with `L` and `Q` as above:
 *
 *   - ROLLING, OR NO FIXED DATE: `inactive` on `t >= L and t > Q` — from `max(Q, L)` on. A future fixed
 *     deadline therefore only POSTPONES the close; it does not prevent it. And a PAST `L` still counts:
 *     the rule was not `inactive` before it, so a projection that dropped it would name a date on
 *     which the job did not close the row. At exactly `max(Q, L)` the rule already says `inactive`
 *     when `L > Q`, and says it from just after when `Q >= L` (the clock test is strict).
 *   - FIXED DATES AND NO ROLLING ENTRY: (1) and (2) meet at the single instant `t = L`, so the rule is
 *     `inactive` exactly at `L` when `Q < L`, and `past_due` from just after it. Returned as `L` —
 *     the projection names the instant the job's predicate names, nothing more. Otherwise `null`:
 *     past `L` it is past due, which is also the case for a record that is past due already (the
 *     next run closes it on its deadlines, and refreshing its clock would not change that).
 *
 * The job runs on a schedule, not continuously: the row closes at the first run at or after the
 * returned instant, and an instant in the past means the next run. Every returned instant is
 * `>= Q`, which is what lets the "closing soon" scan stop early (`services/review/closing-soon.ts`).
 * Pinned against `stalenessClosureReason` itself, ±1 ms and exactly, by
 * `test/unit/staleness-rule.test.ts`.
 */
export function inactivityClosesAt(
  row: StalenessFacts,
  now: Date,
  inactiveDays: number,
): Date | null {
  if (isPastDue(row.deadlines, now)) return null;
  const latest = latestFixedDeadlineAt(row.deadlines);
  const quietUntil = inactivityClockOf(row).getTime() + inactiveDays * DAY_MS;
  if (latest !== null && !hasRollingDeadline(row.deadlines)) {
    // Not past due at `now`, so `latest >= now`: the one instant (1) and (2) both hold is ahead.
    return quietUntil < latest.getTime() ? latest : null;
  }
  return new Date(Math.max(quietUntil, latest?.getTime() ?? quietUntil));
}

/**
 * What decides when this listing closes — and so whether a reviewer's "confirm still open" can do
 * anything about it.
 *
 *   - `inactivity`: refreshing the clock NOW moves the earliest close later. A confirmation buys
 *     real time.
 *   - `final_deadline`: it does not. Either the listing has fixed deadlines and no rolling intake
 *     (it closes at its final deadline whatever its clock says — `inactive` at that instant when it
 *     is quiet, `past_due` just after it either way), or it is a rolling programme whose last fixed
 *     deadline is later than a fresh clock would run (`max(clock + days, L)` stays `L`).
 *
 * Decided by the same projection, evaluated twice — as stored and with the clock refreshed to `now`
 * — so it cannot disagree with `inactivityClosesAt`, or with the job behind it.
 */
export type ClosingDriver = "inactivity" | "final_deadline";

export function closingDriver(row: StalenessFacts, now: Date, inactiveDays: number): ClosingDriver {
  const asStored = inactivityClosesAt(row, now, inactiveDays);
  const refreshed = inactivityClosesAt({ ...row, lastSeenAt: now }, now, inactiveDays);
  const extends_ =
    refreshed !== null && (asStored === null || refreshed.getTime() > asStored.getTime());
  return extends_ ? "inactivity" : "final_deadline";
}
