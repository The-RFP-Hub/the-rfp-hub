import { and, count, eq, max, sql } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { opportunities } from "../../../db/schema.js";

export interface StatsSummary {
  /** Total publicly visible (approved + listed) opportunities. */
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  topEcosystems: { ecosystem: string; count: number }[];
  /** Most recent `updatedAt` across the public dataset (ISO), or null when empty. */
  lastUpdatedAt: string | null;
}

/** Aggregate counts for the `/v1/stats` endpoint (public dataset only). */
export class StatsService {
  constructor(private readonly db: DB = defaultDb) {}

  async summary(): Promise<StatsSummary> {
    const live = and(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true));

    const [totalRows, byType, byStatus, ecoRes, updatedRows] = await Promise.all([
      this.db.select({ value: count() }).from(opportunities).where(live),
      this.db
        .select({ key: opportunities.type, value: count() })
        .from(opportunities)
        .where(live)
        .groupBy(opportunities.type),
      this.db
        .select({ key: opportunities.status, value: count() })
        .from(opportunities)
        .where(live)
        .groupBy(opportunities.status),
      this.db.execute(sql`
        SELECT e AS ecosystem, count(*)::int AS count
        FROM ${opportunities}, unnest(${opportunities.ecosystems}) AS e
        WHERE ${live}
        GROUP BY e
        ORDER BY count DESC, e ASC
        LIMIT 10
      `),
      this.db
        .select({ value: max(opportunities.updatedAt) })
        .from(opportunities)
        .where(live),
    ]);

    const tally = (rows: { key: string; value: number }[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    };

    const topEcosystems = (ecoRes.rows as { ecosystem: string; count: number }[]).map((r) => ({
      ecosystem: r.ecosystem,
      count: Number(r.count),
    }));

    const lastUpdated = updatedRows[0]?.value ?? null;

    return {
      total: totalRows[0]?.value ?? 0,
      byType: tally(byType),
      byStatus: tally(byStatus),
      topEcosystems,
      lastUpdatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    };
  }
}
