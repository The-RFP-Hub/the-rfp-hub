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
      "Recompute the two days before today of daily per-entry traffic totals from raw events.",
    run: (options) => new AnalyticsRollupService(dbOf(options)).runBatch({ now: options.now }),
  },
  {
    name: "retention",
    shape: "sweep",
    describes: "Delete raw analytics events older than ANALYTICS_RETENTION_DAYS.",
    run: (options) =>
      new AnalyticsRollupService(dbOf(options)).pruneRetention({ now: options.now }),
  },
  {
    name: "embedding-backfill",
    shape: "cursor",
    describes: "Embed entries that have no vector for the configured provider, and pair them.",
    // The immediate-email accelerator is switched OFF here, and only here: a job container tears
    // its pool down as soon as the job resolves, which would strand the fire-and-forget sends this
    // backfill's new notifications trigger. `notification-dispatch` in the same nightly matrix
    // delivers them. See `noopNotificationDispatchQueue`. This catalogue is also what the admin
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

export function findJob(name: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === name);
}
