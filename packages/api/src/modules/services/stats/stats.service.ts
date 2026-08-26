import { type DB, db as defaultDb } from "../../../db/client.js";
import { type Repositories, repositories } from "../../repositories/index.js";

export interface StatsSummary {
  /** Total publicly visible (approved + listed) opportunities. */
  total: number;
  /** Counts per Standard `fundingType` (renamed from `byType` with the v1.0.0 re-cut). */
  byFundingType: Record<string, number>;
  byStatus: Record<string, number>;
  topEcosystems: { ecosystem: string; count: number }[];
  /** Most recent `updatedAt` across the public dataset (ISO), or null when empty. */
  lastUpdatedAt: string | null;
}

/** Aggregate counts for the `/v1/stats` endpoint (public dataset only). */
export class StatsService {
  private readonly repos: Repositories;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  async summary(): Promise<StatsSummary> {
    const { totalRows, byFundingType, byStatus, ecosystemRows, updatedRows } =
      await this.repos.opportunities.stats();

    const tally = (rows: { key: string; value: number }[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    };

    const topEcosystems = ecosystemRows.map((r) => ({
      ecosystem: r.ecosystem,
      count: Number(r.count),
    }));

    const lastUpdated = updatedRows[0]?.value ?? null;

    return {
      total: totalRows[0]?.value ?? 0,
      byFundingType: tally(byFundingType),
      byStatus: tally(byStatus),
      topEcosystems,
      lastUpdatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    };
  }
}
