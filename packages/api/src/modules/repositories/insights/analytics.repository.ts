import { type SQL, and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityEventInsert,
  opportunities,
  opportunityEvents,
  opportunityStatsDaily,
} from "../../../db/schema.js";

export interface AnalyticsStatsWrite {
  opportunityId: number;
  day: string;
  listViews: number;
  detailViews: number;
  sourceClicks: number;
  applyClicks: number;
  updatedAt: Date;
}

export class AnalyticsRepository {
  constructor(private readonly exec: DbLike) {}

  async findOpportunityByPublicId(publicId: string) {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    return rows[0];
  }

  /** This projection belongs here because it is the subject set for an analytics summary. */
  async listOwnedOpportunities(owner: { accountId: number; namespaces: string[] }) {
    return this.exec
      .select({
        id: opportunities.id,
        publicId: opportunities.publicId,
        title: opportunities.title,
      })
      .from(opportunities)
      .where(ownedBy(owner));
  }

  async listDailyStatsForOpportunity(opportunityId: number, from: string, through: string) {
    return this.exec
      .select()
      .from(opportunityStatsDaily)
      .where(
        and(
          eq(opportunityStatsDaily.opportunityId, opportunityId),
          gte(opportunityStatsDaily.day, from),
          lte(opportunityStatsDaily.day, through),
        ),
      );
  }

  async listDailyStats(opportunityIds: number[], from: string, through: string) {
    return this.exec
      .select()
      .from(opportunityStatsDaily)
      .where(
        and(
          inArray(opportunityStatsDaily.opportunityId, opportunityIds),
          gte(opportunityStatsDaily.day, from),
          lte(opportunityStatsDaily.day, through),
        ),
      );
  }

  async aggregateEvents(opportunityIds: number[], start: Date, end: Date) {
    return this.exec
      .select({
        opportunityId: opportunityEvents.opportunityId,
        eventType: opportunityEvents.eventType,
        total: sql<number>`count(*)::int`,
      })
      .from(opportunityEvents)
      .where(
        and(
          inArray(opportunityEvents.opportunityId, opportunityIds),
          gte(opportunityEvents.occurredAt, start),
          sql`${opportunityEvents.occurredAt} < ${end}`,
        ),
      )
      .groupBy(opportunityEvents.opportunityId, opportunityEvents.eventType);
  }

  async resolveOpportunityIds(publicIds: string[]) {
    return this.exec
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(inArray(opportunities.publicId, publicIds));
  }

  async insertEvents(rows: OpportunityEventInsert[]): Promise<void> {
    await this.exec.insert(opportunityEvents).values(rows);
  }

  async aggregateDay(start: Date, end: Date) {
    return this.exec
      .select({
        opportunityId: opportunityEvents.opportunityId,
        eventType: opportunityEvents.eventType,
        total: sql<number>`count(*)::int`,
      })
      .from(opportunityEvents)
      .where(
        and(
          gte(opportunityEvents.occurredAt, start),
          lt(opportunityEvents.occurredAt, end),
          // Only entries that still exist. Redundant while `opportunity_events` cascades from
          // `opportunities` (it does, and `0003` says so) — kept because this sweep should not
          // depend on that cascade to avoid computing statistics for a row nobody can look at.
          sql`exists (select 1 from ${opportunities} where ${opportunities.id} = ${opportunityEvents.opportunityId})`,
        ),
      )
      .groupBy(opportunityEvents.opportunityId, opportunityEvents.eventType);
  }

  async aliveOpportunityIds(ids: number[]): Promise<number[]> {
    const rows = await this.exec
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(inArray(opportunities.id, ids));
    return rows.map((row) => row.id);
  }

  async upsertDailyStats(values: AnalyticsStatsWrite[], now: Date): Promise<void> {
    await this.exec
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
  }

  /**
   * Delete raw events older than `cutoff`, and report how many went.
   *
   * Deliberately NOT `.returning({id})`. The caller wants a count, and `returning` makes the
   * server build and ship a row per deleted event to get one — on a prune whose whole point is that
   * it removes a lot of them at once, that is a result set nobody reads, sized by the backlog. The
   * driver already reports `rowCount` for a plain DELETE, which is the same number for free.
   */
  async deleteEventsBefore(cutoff: Date): Promise<number> {
    const deleted = await this.exec
      .delete(opportunityEvents)
      .where(lt(opportunityEvents.occurredAt, cutoff));
    return deleted.rowCount ?? 0;
  }
}

/** Submitted by this account, or published under a namespace it belongs to. */
export function ownedBy(owner: { accountId: number; namespaces: string[] }): SQL | undefined {
  const mine = eq(opportunities.submittedBy, owner.accountId);
  if (owner.namespaces.length === 0) return mine;
  return or(mine, inArray(opportunities.sourcePublisher, owner.namespaces));
}
