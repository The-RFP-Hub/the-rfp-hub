/**
 * The one shape every scheduled job returns, and the distinction that keeps the runner terminating.
 *
 * `{processed, remaining, skipped?}` is deliberately the same for all of them, so the runner, the
 * admin route and the workflow all read one contract. What differs is what `remaining` MEANS, and
 * that difference is the whole of the cursor/sweep split documented in `docs/jobs.md`:
 *
 *   **Cursor jobs** (`staleness`, both backfills, `notification-dispatch`) select rows by a
 *   predicate the run retires or deliberately leaves waiting for a later retry. `remaining`
 *   counts what the predicate still matches, so it falls, and the runner may go round again until
 *   a no-progress pass stops it.
 *
 *   **Sweep jobs** (`analytics-rollup`, `retention`) deliberately reprocess a fixed window every
 *   time — the rollup recomputes the two days before today precisely so a late-arriving event is
 *   never permanently missing. Their selection never empties, so they report `remaining: 0` ALWAYS, and
 *   that value is what stops the runner looping them. The rule is structural rather than a special
 *   case in the runner: a job that reports 0 is not asked again.
 *
 * `skipped` means the job did not run because the FEATURE is off — no embedding provider,
 * `VERIFICATION_ENABLED=false`, or no delivering email transport. It is deliberately distinct from the runner's own
 * `{skipped: "locked"}`, which means another run held the advisory lock. Both exit 0; only one of
 * them says something about configuration.
 */

export interface JobResult {
  /** Rows this invocation actually changed. Zero is what tells a runner to stop. */
  processed: number;
  /** What the job's own predicate still matches. Always 0 for a sweep — see above. */
  remaining: number;
  /** Present when the job declined to do anything because its feature is not configured. */
  skipped?: string;
  /** Free-form per-job counters, for the log line and the admin response. */
  details?: Record<string, number>;
}
