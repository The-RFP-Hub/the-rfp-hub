/**
 * The nightly analytics rollup, and the retention prune that is the reason the raw table is not
 * partitioned.
 *
 * A SWEEP JOB, NOT A CURSOR JOB, and the distinction is not bookkeeping. A cursor job selects rows
 * by a predicate that the run itself retires, so `remaining` falls and a runner may loop it to zero.
 * This one deliberately REPROCESSES a fixed window every time — the last three days — so its
 * selection never empties. Applying a loop-to-zero contract to it would never terminate. It runs
 * once per invocation and always reports `remaining: 0`, which is what `docs/jobs.md` records.
 *
 * WHY THREE DAYS AND NOT ONE. An event can be written after its day has rolled over: the buffer
 * flushes on a timer, a deployment restarts mid-flush, a clock is off. Recomputing yesterday and
 * the day before costs two extra grouped scans and means a late event is never permanently missing.
 *
 * ASSIGNMENT, NEVER INCREMENT. The rollup writes `count(*)` for the day, not `existing + n`. An
 * increment is only correct if the job runs exactly once per day forever — the first retry, the
 * first manual run, the first overlapping schedule silently doubles a publisher's numbers, and
 * nothing about the resulting figure looks wrong. Assignment makes a second run a no-op, which is
 * what makes the job safe to re-run at all.
 */
import { and, gte, lt, sql } from "drizzle-orm";
import { type AppConfig, config as defaultConfig } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { opportunityEvents, opportunityStatsDaily } from "../../../db/schema.js";
import { COLUMN_OF, utcDay } from "./insights.service.js";

/** How many days back a sweep recomputes, including today. */
export const ROLLUP_WINDOW_DAYS = 3;

export interface RollupResult {
  /** Day-rows written. */
  processed: number;
  /** Always 0: a sweep reprocesses a fixed window and is never looped. */
  remaining: number;
  days: string[];
}

export class AnalyticsRollupService {
  private readonly config: AppConfig;

  constructor(
    private readonly db: DB = defaultDb,
    options: { config?: AppConfig } = {},
  ) {
    this.config = options.config ?? defaultConfig;
  }

  /**
   * Recompute the last `days` days of `opportunity_stats_daily` from the raw events.
   *
   * Idempotent by construction (see the header): running it twice writes the same numbers.
   */
  async runBatch(options: { days?: number; now?: Date } = {}): Promise<RollupResult> {
    const days = options.days ?? ROLLUP_WINDOW_DAYS;
    const today = utcDay(options.now ?? new Date());
    const written: string[] = [];
    let processed = 0;

    for (let offset = days - 1; offset >= 0; offset--) {
      const day = shift(today, -offset);
      processed += await this.rollDay(day);
      written.push(day);
    }
    return { processed, remaining: 0, days: written };
  }

  /** One day, one grouped scan, one upsert per entry that had any traffic. */
  private async rollDay(day: string): Promise<number> {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${shift(day, 1)}T00:00:00.000Z`);

    const rows = await this.db
      .select({
        opportunityId: opportunityEvents.opportunityId,
        eventType: opportunityEvents.eventType,
        total: sql<number>`count(*)::int`,
      })
      .from(opportunityEvents)
      .where(and(gte(opportunityEvents.occurredAt, start), lt(opportunityEvents.occurredAt, end)))
      .groupBy(opportunityEvents.opportunityId, opportunityEvents.eventType);

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

    await this.db
      .insert(opportunityStatsDaily)
      .values(values)
      .onConflictDoUpdate({
        target: [opportunityStatsDaily.opportunityId, opportunityStatsDaily.day],
        set: {
          // ASSIGNED from the excluded row, not added to the stored one. See the header.
          listViews: sql`excluded.list_views`,
          detailViews: sql`excluded.detail_views`,
          sourceClicks: sql`excluded.source_clicks`,
          applyClicks: sql`excluded.apply_clicks`,
          updatedAt: now,
        },
      });
    return values.length;
  }

  /**
   * Delete raw events older than `ANALYTICS_RETENTION_DAYS`.
   *
   * This is what `PARTITION BY RANGE` would have bought, and the reason it was deferred: at this
   * volume a bounded `DELETE` by age over an index on `occurred_at` is enough, and it needs no DDL
   * that drizzle-kit cannot generate and nobody would keep in step by hand. The ROLLUP survives the
   * prune — the daily rows are the long-term record; the raw events are the working set.
   */
  async pruneRetention(options: { now?: Date } = {}): Promise<{ processed: number; remaining: 0 }> {
    const cutoff = new Date(options.now ?? new Date());
    cutoff.setUTCDate(cutoff.getUTCDate() - this.config.analytics.retentionDays);
    const deleted = await this.db
      .delete(opportunityEvents)
      .where(lt(opportunityEvents.occurredAt, cutoff))
      .returning({ id: opportunityEvents.id });
    return { processed: deleted.length, remaining: 0 };
  }
}

/** `YYYY-MM-DD` shifted by whole days, in UTC. */
function shift(day: string, byDays: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + byDays);
  return utcDay(at);
}
