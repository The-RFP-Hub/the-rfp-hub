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
 * `stalenessClosureReason` PROJECTED FORWARD: the instant after which it says `inactive` for this
 * row as it is stored now, or `null` when it never will.
 *
 * The rule says `inactive` at time `t` when all three hold:
 *
 *   1. not past due at `t`;
 *   2. no fixed deadline strictly after `t`  — i.e. `t >= latest fixed date`, when there is one;
 *   3. `clock < t - days`                    — i.e. `t > clock + days`.
 *
 * A FUTURE FIXED DEADLINE ONLY POSTPONES THE INACTIVITY CLOSE; it does not prevent it. Once the last
 * fixed date passes, (2) holds, and an entry that has been quiet the whole time closes at the first
 * run after both (2) and (3) are true: `max(clock + days, latest fixed date)`. What decides whether
 * that ever happens is (1):
 *
 *   - WITH A ROLLING ENTRY the record is never past due, so it is projected as above;
 *   - WITH NO FIXED DATE AT ALL there is nothing to wait for: `clock + days`;
 *   - FIXED DATES AND NO ROLLING ENTRY: while one is ahead, (2) fails; the moment the last one passes,
 *     the record is past due and closes as `past_due` instead. Never `inactive` → `null`. This
 *     includes a record that is past due already: the next run closes it on its deadlines, and
 *     refreshing the clock would not change that, so it is not something a reviewer can keep open.
 *
 * The job runs on a schedule, not continuously, so the returned instant is the earliest the rule
 * can say `inactive`; the row closes on the first run after it, and an instant in the past means the
 * next run. Pinned against `stalenessClosureReason` itself by `test/unit/staleness-rule.test.ts`.
 */
export function inactivityClosesAt(
  row: StalenessFacts,
  now: Date,
  inactiveDays: number,
): Date | null {
  if (isPastDue(row.deadlines, now)) return null;
  const latest = latestFixedDeadlineAt(row.deadlines);
  if (latest !== null && !hasRollingDeadline(row.deadlines)) return null;
  const quietUntil = inactivityClockOf(row).getTime() + inactiveDays * DAY_MS;
  // `latest` in the past is already satisfied by any `t` from now on; only a future one waits.
  const deadlinesUntil = latest !== null && latest.getTime() > now.getTime() ? latest.getTime() : 0;
  return new Date(Math.max(quietUntil, deadlinesUntil));
}
