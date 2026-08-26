/**
 * The job catalogue — the single list the runner, the admin route and the schedule all read.
 *
 * There is exactly one place a job name is spelled, and it is here. A workflow naming a job that
 * does not exist fails on its first run with the list of ones that do, instead of starting a
 * container task that quietly does nothing; the admin route rejects an unknown name with a 404 for
 * the same reason.
 *
 * Each entry carries its SHAPE, and the shape is not decoration:
 *
 *   `cursor` — the run retires its own selection, so a runner may go round again while it is still
 *              making progress;
 *   `sweep`  — the run reprocesses a fixed window by design, always reports `remaining: 0`, and is
 *              therefore never looped. The rollup re-selects the two days before today on purpose;
 *              a loop-to-zero contract applied to it would not terminate.
 *
 * The lock is taken per NAME (see `lock.ts`), so `staleness` excludes another `staleness` and
 * nothing else. Two different jobs run concurrently quite happily.
 */
import { type DB, db as defaultDb } from "../../../db/client.js";
import { DedupeService } from "../dedupe/dedupe.service.js";
import { AnalyticsRollupService } from "../insights/rollup.service.js";
import { noopNotificationDispatchQueue } from "../notifications/notification-dispatch.queue.js";
import {
  type NotificationDispatchOptions,
  NotificationDispatchService,
} from "../notifications/notification-dispatch.service.js";
import { VerificationService } from "../verification/verification.service.js";
import { StalenessService } from "./staleness.service.js";
import type { JobResult } from "./types.js";

export type JobShape = "cursor" | "sweep";

export interface JobDefinition {
  name: string;
  shape: JobShape;
  /** One line, used by `--help`, the OpenAPI description and `docs/jobs.md`. */
  describes: string;
  /**
   * The name that replaced this one. Present only on an alias kept alive for one release so an
   * external scheduler still naming it gets its work done instead of an exit 2 — see `retention`.
   * Aliases are not in `CHAIN`, so `jobs.js all` never runs one.
   */
  deprecatedFor?: string;
  run(options: JobRunOptions): Promise<JobResult>;
}

export interface JobRunOptions {
  /** Bound on the work one invocation does. Cursor jobs only; a sweep ignores it. */
  limit?: number;
  /** Injected clock, for the suites that seed relative dates. */
  now?: Date;
  db?: DB;
  /** Injection seam for the dispatcher integration suite. */
  notificationDispatch?: NotificationDispatchOptions;
}

function dbOf(options: JobRunOptions): DB {
  return options.db ?? defaultDb;
}

/**
 * THE ARRAY ORDER IS THE CHAIN ORDER, and `staleness` is last in it because it has to be.
 *
 * The header above used to say so while the array said otherwise — `staleness` sat fifth, ahead of
 * `notification-dispatch` — which is exactly the kind of drift a comment cannot be trusted to
 * police. It matters now beyond tidiness: `--help`, the admin route's enum and (from here on) the
 * `all` chain runner all read this array in order, so a reader who takes the listing as the running
 * order is right rather than nearly right.
 *
 * Why `staleness` is last is the one real ordering rule the chain carries (`docs/jobs.md` §4d): a
 * successful source check writes `lastSeenAt`, which is the input to staleness's own inactivity
 * clock, so staleness running before `verification-backfill` has exited closes entries that check
 * was about to prove alive — and both runs report success. Everything before it writes nothing the
 * others read. Provider refusals are durable row state rather than thrown job errors, so the
 * notification backstop does not fail the chain merely because mail is unavailable.
 */
export const JOBS: JobDefinition[] = [
  {
    name: "analytics-rollup",
    shape: "sweep",
    describes:
      "Recompute the two days before today of per-entry traffic totals, then prune raw events past retention.",
    run: (options) => new AnalyticsRollupService(dbOf(options)).runBatch({ now: options.now }),
  },
  {
    /**
     * DEPRECATED, AND KEPT ONLY SO A SCHEDULER OUTSIDE THIS REPOSITORY DOES NOT BREAK.
     *
     * The prune runs inside `analytics-rollup` now (`rollup.service.ts` explains why). The name
     * lives on for one release because the nightly chain is scheduled elsewhere and a caller still
     * naming `retention` would otherwise exit 2 — a maintenance run that fails loudly for a reason
     * nobody at the console can act on that night. It does the prune, alone, so a caller running
     * the old six-job chain gets the same outcome as the new one; a caller running BOTH names
     * simply prunes twice, which deletes nothing the first pass left.
     */
    name: "retention",
    shape: "sweep",
    deprecatedFor: "analytics-rollup",
    describes:
      "DEPRECATED alias for analytics-rollup, which now prunes. Runs the retention prune alone.",
    run: (options) =>
      new AnalyticsRollupService(dbOf(options)).pruneRetention({ now: options.now }),
  },
  {
    name: "embedding-backfill",
    shape: "cursor",
    describes: "Embed entries that have no vector for the configured provider, and pair them.",
    // The immediate-email accelerator is switched OFF here, and only here: a job container tears
    // its pool down as soon as the job resolves, which would strand the fire-and-forget sends this
    // backfill's new notifications trigger. `notification-dispatch` delivers them instead, and
    // `CHAIN` runs it AFTER this job for that reason — see the note there.
    // See `noopNotificationDispatchQueue`. This catalogue is also what the admin
    // job route runs, so an admin-triggered backfill takes the same durable path rather than the
    // accelerator — the alternative was a per-caller mode flag on a job definition, which is a
    // worse thing to own than a backfill's mail arriving on the nightly cycle.
    run: (options) =>
      new DedupeService(dbOf(options), {
        notificationQueue: noopNotificationDispatchQueue,
      }).runBatch({ limit: options.limit }),
  },
  {
    name: "verification-backfill",
    shape: "cursor",
    describes:
      "Fetch the applicationUrl of entries never checked or edited since their last check.",
    run: (options) => new VerificationService(dbOf(options)).runBatch({ limit: options.limit }),
  },
  {
    name: "notification-dispatch",
    shape: "cursor",
    describes: "Deliver pending account notifications by email, with bounded retries.",
    run: (options) =>
      new NotificationDispatchService(dbOf(options), options.notificationDispatch).runBatch({
        limit: options.limit,
        now: options.now,
      }),
  },
  {
    name: "staleness",
    shape: "cursor",
    describes: "Close past-due and long-inactive entries, and recompute the derived deadline key.",
    run: (options) =>
      new StalenessService(dbOf(options)).runBatch({ limit: options.limit, now: options.now }),
  },
];

export const JOB_NAMES: string[] = JOBS.map((job) => job.name);

/**
 * The nightly chain, in the order one caller must run it. `jobs.js all` reads exactly this.
 *
 * Derived from `JOBS` rather than restated, because a second copy of an ordering is a copy that
 * drifts — and the drift would be silent, since both lists look plausible on their own. What the
 * derivation drops is the deprecated aliases: `retention` does work `analytics-rollup` already
 * does, so running it here would prune twice for no one's benefit.
 *
 * THE ORDER CARRIES TWO THINGS, one hard and one worth having.
 *
 *   - `staleness` LAST, and this is the rule `docs/jobs.md` §4d states: it must come after
 *     `verification-backfill` has exited, or it closes entries a successful check was about to
 *     prove alive — with both runs reporting success.
 *   - `notification-dispatch` AFTER `embedding-backfill`, which is softer but real. The backfill
 *     runs with the immediate-email accelerator switched off (see its entry), so the notifications
 *     it inserts wait for the dispatcher. Ordering it later means they go out the SAME night
 *     instead of the next one. Nothing breaks if a caller reverses them — the rows are durable and
 *     the next sweep takes them — so this is latency, not correctness.
 *
 * `test/unit/jobs.test.ts` pins the sequence literally, so adding a job to `JOBS` is a deliberate
 * change to the chain rather than an accidental one.
 */
export const CHAIN: readonly string[] = JOBS.filter((job) => job.deprecatedFor === undefined).map(
  (job) => job.name,
);

export function findJob(name: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === name);
}
