/**
 * Best-effort post-commit notification email attempts.
 *
 * The queue is deliberately only an accelerator. Notification rows and their delivery columns are
 * the source of truth; rejecting an id at the bound, losing the process, or seeing a worker failure
 * leaves the row untouched (or retryable) for the nightly `notification-dispatch` sweep.
 */
import { config } from "../../../config.js";
import type { JobResult } from "../jobs/types.js";
import {
  type NotificationDispatchBatchOptions,
  NotificationDispatchService,
} from "./notification-dispatch.service.js";

/** Provider sends are serial here; the bounded waiting list is the request-path resource limit. */
const CONCURRENCY = 1;

export interface NotificationDispatchRunner {
  runBatch(options?: NotificationDispatchBatchOptions): Promise<JobResult>;
}

export interface NotificationDispatchQueueOptions {
  queueMax?: number;
  dispatcher?: NotificationDispatchRunner;
}

export interface NotificationDispatchEnqueuer {
  enqueue(notificationIds: readonly number[]): void;
}

export class NotificationDispatchQueue {
  /** Ids waiting for an immediate attempt. Overflow rejects the newest id to the nightly sweep. */
  private readonly queue: number[] = [];
  /**
   * Ids handed to the dispatcher and not yet finished.
   *
   * The waiting list alone was not a membership test: `pump()` shifts an id off it before the send
   * starts, so an id re-enqueued mid-flight was "not in the queue" and got a second attempt of its
   * own. The row lease makes that second attempt harmless at the database, but the queue should not
   * be spending a provider round trip to discover it.
   */
  private readonly inFlight = new Set<number>();
  private readonly queueMax: number;
  private readonly dispatcher: NotificationDispatchRunner;
  private active = 0;

  constructor(options: NotificationDispatchQueueOptions = {}) {
    this.queueMax = options.queueMax ?? config.notifications.queueMax;
    this.dispatcher = options.dispatcher ?? new NotificationDispatchService();
  }

  /** Waiting plus in flight — useful for asserting the configured bound and eventual drain. */
  get queueDepth(): number {
    return this.queue.length + this.active;
  }

  /**
   * Start immediate attempts for newly committed notification ids, and accept being told no.
   *
   * This method never awaits provider I/O and never throws into the mutation that just committed.
   * When the waiting list is full, the newest id is rejected; its durable row is the retry seam.
   */
  enqueue(notificationIds: readonly number[]): void {
    try {
      for (const notificationId of notificationIds) {
        if (!Number.isInteger(notificationId) || notificationId <= 0) continue;
        if (this.queue.length >= this.queueMax) continue;
        if (this.queue.includes(notificationId) || this.inFlight.has(notificationId)) continue;
        this.queue.push(notificationId);
        this.pump();
      }
    } catch {
      // The notification transaction has committed. Its row is sufficient for the nightly sweep.
    }
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const notificationId = this.queue.shift();
      if (notificationId === undefined) return;
      this.active++;
      this.inFlight.add(notificationId);
      void this.dispatcher
        .runBatch({ limit: 1, notificationIds: [notificationId] })
        .catch(() => {
          // A provider or database failure cannot be reported to the request that already returned.
          // The durable row remains undispatched (or retryable) for the nightly sweep.
        })
        .finally(() => {
          this.active--;
          this.inFlight.delete(notificationId);
          this.pump();
        });
    }
  }
}

/** The API process owns one bounded queue, matching the verification submit-time queue pattern. */
export const notificationDispatchQueue = new NotificationDispatchQueue();

/**
 * What a JOB CONTAINER enqueues with: nothing.
 *
 * The accelerator exists so a user's own request does not wait a nightly cycle for its mail, and a
 * one-off task has no user waiting on it. What it does have is `run-job.ts`, which ends with
 * `pool.end()` the moment the job resolves — while these sends are deliberately fire-and-forget on
 * that same pool. A backfill that creates notifications would therefore exit with sends still in
 * flight, and their `markDispatched` would fail on a closed pool: mail delivered, row never
 * stamped, the same mail again on the next nightly sweep. The dispatch job in the same nightly
 * matrix is already the durable path for those rows, so the container simply does not accelerate.
 */
export const noopNotificationDispatchQueue: NotificationDispatchEnqueuer = {
  enqueue() {},
};
