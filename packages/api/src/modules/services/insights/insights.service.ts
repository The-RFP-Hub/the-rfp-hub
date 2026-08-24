/**
 * What a publisher sees: how often their entries were read, and how often somebody followed the
 * link out.
 *
 * FRESHNESS IS THE DESIGN CONSTRAINT. A nightly rollup alone means a publisher who posts something
 * in the morning sees zeros all day, which reads as "nobody looked" rather than "we have not
 * counted yet" — and that is the single most likely reason to stop trusting the numbers. So a
 * series is the ROLLUP for every day before today UNION a live aggregate over today's raw events.
 * Yesterday and earlier come from `opportunity_stats_daily`, which is cheap; today is a bounded
 * scan of one day of `opportunity_events`, which is also cheap, and it is current to the second.
 *
 * WHAT THE NUMBERS ARE, stated because the obvious reading is wrong: these are API READS AND
 * LINK-OUTS, not page views. This service does not run the page a human looked at. A dashboard
 * rendering one entry's detail makes one `detail_view`; so does a script. Our own automation is
 * excluded by name, crawlers and `DNT: 1` are dropped, and the whole thing is buffered in memory and
 * therefore crash-lossy. Everything that serves it says "best-effort".
 *
 * FEEDS AND EXPORTS ARE NEVER INSTRUMENTED. A full-dataset download is one request that would
 * otherwise credit every entry in the corpus with a view, which would make the metric meaningless
 * for everybody at once.
 */
import { type SQL, and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { opportunities, opportunityEvents, opportunityStatsDaily } from "../../../db/schema.js";
import type {
  InsightsEntryView,
  InsightsPointView,
  InsightsSeriesView,
  InsightsSummaryView,
  InsightsTotalsView,
} from "../../shared/api-views.js";
import { badRequest, notFound } from "../../shared/http-error.js";

/** The longest window a single request may ask for. */
export const MAX_WINDOW_DAYS = 365;
export const DEFAULT_WINDOW_DAYS = 30;

const ZERO: InsightsTotalsView = { listViews: 0, detailViews: 0, sourceClicks: 0, applyClicks: 0 };

/** `YYYY-MM-DD` in UTC — the same day boundary the rollup and the hashes use. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayBefore(day: string, offset: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - offset);
  return utcDay(at);
}

export interface WindowOptions {
  days?: number;
  now?: Date;
}

export class InsightsService {
  constructor(private readonly db: DB = defaultDb) {}

  /**
   * One entry's daily series, rollups for the past and a live aggregate for today.
   *
   * The caller has already established that this account may see it — ownership is not this
   * service's decision, it is the route's, and it is the same `isPrivileged` rule the rest of the
   * entry's sub-resources use.
   */
  async forOpportunity(publicId: string, options: WindowOptions = {}): Promise<InsightsSeriesView> {
    const row = await this.resolve(publicId);
    const { days, today, from } = this.window(options);

    const rolled = await this.db
      .select()
      .from(opportunityStatsDaily)
      .where(
        and(
          eq(opportunityStatsDaily.opportunityId, row.id),
          gte(opportunityStatsDaily.day, from),
          // Strictly before today: today's numbers come from the live aggregate, and taking both
          // would double-count every event the rollup has already absorbed.
          lte(opportunityStatsDaily.day, dayBefore(today, 1)),
        ),
      );

    const byDay = new Map<string, InsightsTotalsView>();
    for (const day of rolled) {
      byDay.set(day.day, {
        listViews: day.listViews,
        detailViews: day.detailViews,
        sourceClicks: day.sourceClicks,
        applyClicks: day.applyClicks,
      });
    }
    const live = await this.liveTotals([row.id], today);
    const liveForRow = live.get(row.id);
    if (liveForRow) byDay.set(today, liveForRow);

    const series: InsightsPointView[] = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      const day = dayBefore(today, offset);
      series.push({ day, ...(byDay.get(day) ?? ZERO) });
    }

    return {
      opportunityId: row.publicId,
      title: row.title,
      from,
      to: today,
      totals: sum(series),
      days: series,
    };
  }

  /**
   * Every entry this account owns, totalled over the window.
   *
   * "Owns" is the same union the dashboard's listings page uses — submitted by this account, or
   * published under a namespace it holds a membership on — so a publisher sees their organisation's
   * entries even when a colleague filed them.
   */
  async summaryForOwner(
    owner: { accountId: number; namespaces: string[] },
    options: WindowOptions = {},
  ): Promise<InsightsSummaryView> {
    const { days, today, from } = this.window(options);

    const owned = await this.db
      .select({
        id: opportunities.id,
        publicId: opportunities.publicId,
        title: opportunities.title,
      })
      .from(opportunities)
      .where(ownedBy(owner));
    if (owned.length === 0) {
      return { from, to: today, totals: ZERO, opportunities: [] };
    }

    const ids = owned.map((row) => row.id);
    const rolled = await this.db
      .select()
      .from(opportunityStatsDaily)
      .where(
        and(
          inArray(opportunityStatsDaily.opportunityId, ids),
          gte(opportunityStatsDaily.day, from),
          lte(opportunityStatsDaily.day, dayBefore(today, 1)),
        ),
      );

    const totals = new Map<number, InsightsTotalsView>();
    const add = (id: number, values: InsightsTotalsView) => {
      const current = totals.get(id) ?? { ...ZERO };
      totals.set(id, {
        listViews: current.listViews + values.listViews,
        detailViews: current.detailViews + values.detailViews,
        sourceClicks: current.sourceClicks + values.sourceClicks,
        applyClicks: current.applyClicks + values.applyClicks,
      });
    };
    for (const day of rolled) {
      add(day.opportunityId, {
        listViews: day.listViews,
        detailViews: day.detailViews,
        sourceClicks: day.sourceClicks,
        applyClicks: day.applyClicks,
      });
    }
    for (const [id, live] of await this.liveTotals(ids, today)) add(id, live);

    const entries: InsightsEntryView[] = owned
      .map((row) => ({
        opportunityId: row.publicId,
        title: row.title,
        ...(totals.get(row.id) ?? ZERO),
      }))
      .sort(
        (a, b) => b.detailViews - a.detailViews || a.opportunityId.localeCompare(b.opportunityId),
      );

    void days;
    return {
      from,
      to: today,
      totals: sum(entries),
      opportunities: entries,
    };
  }

  /**
   * Today's counts, straight from the raw events.
   *
   * One grouped scan over a single day, index-backed by `ix_event_opp_day`. This is the half that
   * makes a publisher's morning traffic visible in the afternoon instead of tomorrow.
   */
  private async liveTotals(
    opportunityIds: number[],
    day: string,
  ): Promise<Map<number, InsightsTotalsView>> {
    if (opportunityIds.length === 0) return new Map();
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${dayBefore(day, -1)}T00:00:00.000Z`);

    const rows = await this.db
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

    const out = new Map<number, InsightsTotalsView>();
    for (const row of rows) {
      const current = out.get(row.opportunityId) ?? { ...ZERO };
      current[COLUMN_OF[row.eventType]] += Number(row.total);
      out.set(row.opportunityId, current);
    }
    return out;
  }

  private window(options: WindowOptions): { days: number; today: string; from: string } {
    const days = options.days ?? DEFAULT_WINDOW_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      throw badRequest("invalid_window", `\`days\` must be between 1 and ${MAX_WINDOW_DAYS}.`);
    }
    const today = utcDay(options.now ?? new Date());
    return { days, today, from: dayBefore(today, days - 1) };
  }

  private async resolve(publicId: string) {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    return row;
  }
}

/** The event enum → the rollup column it feeds. A merged `views` would lose which one it was. */
export const COLUMN_OF: Record<
  "list_view" | "detail_view" | "source_click" | "apply_click",
  keyof InsightsTotalsView
> = {
  list_view: "listViews",
  detail_view: "detailViews",
  source_click: "sourceClicks",
  apply_click: "applyClicks",
};

/** Submitted by this account, or published under a namespace it belongs to. */
export function ownedBy(owner: { accountId: number; namespaces: string[] }): SQL | undefined {
  const mine = eq(opportunities.submittedBy, owner.accountId);
  if (owner.namespaces.length === 0) return mine;
  return or(mine, inArray(opportunities.sourcePublisher, owner.namespaces));
}

function sum(values: InsightsTotalsView[]): InsightsTotalsView {
  return values.reduce<InsightsTotalsView>(
    (acc, value) => ({
      listViews: acc.listViews + value.listViews,
      detailViews: acc.detailViews + value.detailViews,
      sourceClicks: acc.sourceClicks + value.sourceClicks,
      applyClicks: acc.applyClicks + value.applyClicks,
    }),
    { ...ZERO },
  );
}
