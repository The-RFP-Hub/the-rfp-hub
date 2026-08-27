/**
 * The nightly analytics rollup, and the retention prune that is the reason the raw table is not
 * partitioned.
 *
 * ONE JOB, NOT TWO. `runBatch` settles the window and then prunes, in the same invocation, because
 * they were never independent: both walk `opportunity_events`, both are sweeps over a window keyed
 * on `occurred_at`, and the prune's correctness DEPENDS on the rollup having already absorbed the
 * days it is about to delete. Running them as two scheduled tasks made that dependency the
 * scheduler's to remember, unwritten anywhere it could be checked — and a prune that ran first, on
 * a night the rollup failed, would delete raw events whose totals were never recorded. In one
 * invocation the order cannot be got wrong, and a rollup that throws never reaches the delete.
 *
 * A SWEEP JOB, NOT A CURSOR JOB, and the distinction is not bookkeeping. A cursor job selects rows
 * by a predicate that the run itself retires, so `remaining` falls and a runner may loop it to zero.
 * This one deliberately REPROCESSES a fixed window every time — the two days before today — so its
 * selection never empties. Applying a loop-to-zero contract to it would never terminate. It runs
 * once per invocation and always reports `remaining: 0`, which is what `docs/jobs.md` records.
 *
 * WHY TWO PREVIOUS DAYS, AND WHY TODAY IS NOT ONE OF THEM. `insights.service.ts` reads rollup rows
 * for days STRICTLY BEFORE today and live-aggregates today's raw events instead, precisely so a
 * publisher who posts in the morning does not see zeros all day. So a row written for today is a
 * row nothing ever reads — a grouped scan of the busiest, still-growing day of the table, whose
 * result is overwritten by the next night's sweep before it can be used. Dropping it is the whole
 * of the saving; nothing downstream can tell the difference.
 *
 * The two days that remain are the late-arrival margin, and they are what makes the window a sweep
 * rather than a single day. An event can be written after its day has rolled over: the buffer
 * flushes on a timer, a deployment restarts mid-flush, a clock is off. Recomputing yesterday AND
 * the day before costs one extra grouped scan over a day that has stopped changing, and means a
 * late event is never permanently missing.
 *
 * ASSIGNMENT, NEVER INCREMENT. The rollup writes `count(*)` for the day, not `existing + n`. An
 * increment is only correct if the job runs exactly once per day forever — the first retry, the
 * first manual run, the first overlapping schedule silently doubles a publisher's numbers, and
 * nothing about the resulting figure looks wrong. Assignment makes a second run a no-op, which is
 * what makes the job safe to re-run at all.
 */
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import {
  type AnalyticsStatsWrite,
  type Repositories,
  repositories,
} from "../../repositories/index.js";
import { COLUMN_OF, utcDay } from "./insights.service.js";

/**
 * Postgres foreign-key violation, read through the driver error the ORM wraps.
 *
 * Here it means exactly one thing: the entry these statistics are about was deleted while they were
 * being computed.
 */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) return false;
    const named = current as { code?: string; cause?: unknown };
    if (named.code !== undefined) return named.code === "23503";
    current = named.cause;
  }
  return false;
}

/**
 * How many PREVIOUS days a sweep recomputes. Today is deliberately not one of them — see the
 * header: nothing reads today's rollup row, because the series live-aggregates today.
 */
export const ROLLUP_WINDOW_DAYS = 2;

export interface RollupResult {
  /** Day-rows written. The prune's own count is in `details.pruned`, not added in here. */
  processed: number;
  /** Always 0: a sweep reprocesses a fixed window and is never looped. */
  remaining: number;
  days: string[];
  /** `pruned` — raw events deleted for age by the same invocation. */
  details: { pruned: number };
}

export class AnalyticsRollupService {
  private readonly config: AppConfig;
  private readonly repos: Repositories;

  constructor(db: DB = defaultDb, options: { config?: AppConfig } = {}) {
    this.repos = repositories(db);
    this.config = options.config ?? defaultConfig;
  }

  /**
   * Recompute the `days` days BEFORE today in `opportunity_stats_daily`, then prune raw events
   * past `ANALYTICS_RETENTION_DAYS`.
   *
   * Idempotent by construction (see the header): running it twice writes the same numbers and
   * deletes nothing the first run left behind.
   *
   * THE PRUNE IS LAST, AND ONLY REACHED ON SUCCESS. A rollup that throws propagates from here
   * without deleting anything — which is the point of putting the two in one invocation: the day
   * the rollup fails is exactly the day its raw events must survive to be re-rolled tomorrow.
   */
  async runBatch(options: { days?: number; now?: Date } = {}): Promise<RollupResult> {
    const days = options.days ?? ROLLUP_WINDOW_DAYS;
    const today = utcDay(options.now ?? new Date());
    const written: string[] = [];
    let processed = 0;

    // Oldest first, and stopping at offset 1: offset 0 is today, which no reader consults.
    for (let offset = days; offset >= 1; offset--) {
      const day = shift(today, -offset);
      processed += await this.rollDay(day);
      written.push(day);
    }

    const { processed: pruned } = await this.pruneRetention({ now: options.now });
    return { processed, remaining: 0, days: written, details: { pruned } };
  }

  /** One day, one grouped scan, one upsert per entry that had any traffic. */
  private async rollDay(day: string): Promise<number> {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${shift(day, 1)}T00:00:00.000Z`);

    const rows = await this.repos.analytics.aggregateDay(start, end);

    const byOpportunity = new Map<
      number,
      { listViews: number; detailViews: number; sourceClicks: number; applyClicks: number }
    >();
    for (const row of rows) {
      const current = byOpportunity.get(row.opportunityId) ?? {
        listViews: 0,
        detailViews: 0,
        sourceClicks: 0,
        applyClicks: 0,
      };
      current[COLUMN_OF[row.eventType]] += Number(row.total);
      byOpportunity.set(row.opportunityId, current);
    }
    if (byOpportunity.size === 0) return 0;

    const now = new Date();
    const values = [...byOpportunity].map(([opportunityId, counts]) => ({
      opportunityId,
      day,
      ...counts,
      updatedAt: now,
    }));

    return this.upsert(values, now);
  }

  /**
   * Write one day's rows — and survive an entry that disappears WHILE the sweep is running.
   *
   * The aggregate above and this write are two statements, so an opportunity deleted between them
   * is invisible to the first and gone by the second: the foreign key then rejects the whole batch
   * with `23503` and the nightly job fails, having written nothing for the hundreds of entries that
   * were perfectly fine. Filtering the aggregate cannot prevent this — at read time the row was
   * still there — so the honest answer is to tolerate it: an entry that no longer exists has no
   * statistics worth keeping, so it is dropped and the rest of the day is written.
   *
   * ONE retry, deliberately. A second failure means something other than a racing delete, and a
   * sweep that retried indefinitely would hide it.
   */
  private async upsert(
    values: AnalyticsStatsWrite[],
    now: Date,
    retrying = false,
  ): Promise<number> {
    try {
      await this.write(values, now);
      return values.length;
    } catch (error) {
      if (retrying || !isForeignKeyViolation(error)) throw error;
      const ids = values.map((row) => row.opportunityId);
      const surviving = new Set(await this.repos.analytics.aliveOpportunityIds(ids));
      const remaining = values.filter((row) => surviving.has(row.opportunityId));
      if (remaining.length === 0) return 0;
      return this.upsert(remaining, now, true);
    }
  }

  private async write(values: AnalyticsStatsWrite[], now: Date): Promise<void> {
    await this.repos.analytics.upsertDailyStats(values, now);
  }

  /**
   * Delete raw events older than `ANALYTICS_RETENTION_DAYS`.
   *
   * `runBatch` calls this as its last step; it stays a separate method because the deprecated
   * `retention` job name still runs it alone (see `registry.ts`), and because a test that wants to
   * exercise the prune should not have to roll two days first.
   *
   * This is what `PARTITION BY RANGE` would have bought, and the reason it was deferred: at this
   * volume a bounded `DELETE` by age over an index on `occurred_at` is enough, and it needs no DDL
   * that drizzle-kit cannot generate and nobody would keep in step by hand. The ROLLUP survives the
   * prune — the daily rows are the long-term record; the raw events are the working set.
   */
  async pruneRetention(options: { now?: Date } = {}): Promise<{ processed: number; remaining: 0 }> {
    const cutoff = new Date(options.now ?? new Date());
    cutoff.setUTCDate(cutoff.getUTCDate() - this.config.analytics.retentionDays);
    const deleted = await this.repos.analytics.deleteEventsBefore(cutoff);
    return { processed: deleted, remaining: 0 };
  }
}

/** `YYYY-MM-DD` shifted by whole days, in UTC. */
function shift(day: string, byDays: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + byDays);
  return utcDay(at);
}
