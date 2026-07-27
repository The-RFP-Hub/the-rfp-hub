import type { FundingType, Opportunity, OpportunityStatus } from "@the-rfp-hub/standard";
import {
  type SQL,
  and,
  arrayOverlaps,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityInsert,
  type OrganizationInsert,
  opportunities,
  organizations,
} from "../../../db/schema.js";
import {
  type OpportunityInsertData,
  type OpportunitySummary,
  fromStandard,
  toStandard,
  toSummary,
} from "../../mappers/opportunity.mapper.js";
import { paginate } from "../../shared/pagination.js";

/**
 * Sortable fields. `closesAt` is gone with the re-cut — `nextDeadlineAt` (the derived, denormalized
 * earliest FUTURE fixed deadline) replaces it and is the default.
 */
export type SortField = "nextDeadlineAt" | "opensAt" | "postedAt" | "updatedAt" | "createdAt";

/** Normalized query for the list endpoint (produced by routes/opportunities/types.ts). */
export interface OpportunityQuery {
  fundingType?: FundingType[];
  status?: OpportunityStatus[];
  ecosystem?: string[];
  network?: string[];
  category?: string[];
  tag?: string[];
  /** Sponsoring-organization slug — matches ANY sponsor, not only the primary one. */
  organization?: string;
  minAward?: number;
  maxAward?: number;
  /** Deadline window over `next_deadline_at` (ISO instants). Rolling-only records are excluded. */
  deadlineAfter?: Date;
  deadlineBefore?: Date;
  q?: string;
  sort: SortField;
  order: "asc" | "desc";
  page: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const SORT_COLUMNS = {
  nextDeadlineAt: opportunities.nextDeadlineAt,
  opensAt: opportunities.opensAt,
  postedAt: opportunities.postedAt,
  updatedAt: opportunities.updatedAt,
  createdAt: opportunities.createdAt,
} as const;

/**
 * Escape Postgres LIKE/ILIKE metacharacters (%, _, \) so user text matches literally.
 * Patterns are parameter-bound (no injection) — this is precision only. Backslash is Postgres's
 * default ILIKE escape char, so no explicit ESCAPE clause is required.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** Data + business logic for opportunities. Public reads are always approved + listed. */
export class OpportunityService {
  constructor(private readonly db: DB = defaultDb) {}

  /** Conditions shared by every public read. */
  private liveFilters(q: OpportunityQuery): SQL[] {
    const where: SQL[] = [
      eq(opportunities.reviewStatus, "approved"),
      eq(opportunities.isListed, true),
    ];
    if (q.fundingType?.length) where.push(inArray(opportunities.fundingType, q.fundingType));
    if (q.status?.length) where.push(inArray(opportunities.status, q.status));
    if (q.ecosystem?.length) where.push(arrayOverlaps(opportunities.ecosystems, q.ecosystem));
    if (q.network?.length) where.push(arrayOverlaps(opportunities.networks, q.network));
    if (q.category?.length) where.push(arrayOverlaps(opportunities.categories, q.category));
    if (q.tag?.length) where.push(arrayOverlaps(opportunities.tags, q.tag));
    // ANY sponsoring organization, via the denormalized GIN-indexed slug array.
    if (q.organization) {
      where.push(arrayOverlaps(opportunities.sponsorSlugs, [q.organization]));
    }
    // Include the same-side bound so a row that sets only one of min/max/budget still matches.
    if (q.minAward !== undefined) {
      where.push(
        sql`coalesce(${opportunities.maxAward}, ${opportunities.budget}, ${opportunities.minAward}) >= ${q.minAward}`,
      );
    }
    if (q.maxAward !== undefined) {
      where.push(
        sql`coalesce(${opportunities.minAward}, ${opportunities.budget}, ${opportunities.maxAward}) <= ${q.maxAward}`,
      );
    }
    // Deadline window. `next_deadline_at` is NULL for rolling-only / all-past / no-deadline
    // records, so those are excluded by either bound — documented on the query params.
    if (q.deadlineAfter) where.push(gte(opportunities.nextDeadlineAt, q.deadlineAfter));
    if (q.deadlineBefore) where.push(lte(opportunities.nextDeadlineAt, q.deadlineBefore));
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      const text = or(
        ilike(opportunities.title, like),
        ilike(opportunities.summary, like),
        ilike(opportunities.description, like),
      );
      if (text) where.push(text);
    }
    return where;
  }

  /**
   * Primary ORDER BY. NULLS LAST in BOTH directions so records with no next fixed deadline
   * (rolling-only, all-past, or none at all) always sort after those that have one.
   */
  private orderBy(q: OpportunityQuery): SQL {
    const col = SORT_COLUMNS[q.sort];
    return q.order === "asc" ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
  }

  /** List opportunities (thin projection) with filters, sort and pagination. */
  async getAll(q: OpportunityQuery): Promise<Page<OpportunitySummary>> {
    const { page, limit, offset } = paginate(q.page, q.limit);
    const whereClause = and(...this.liveFilters(q));

    const rows = await this.db
      .select()
      .from(opportunities)
      .where(whereClause)
      .orderBy(this.orderBy(q), desc(opportunities.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.db.select({ value: count() }).from(opportunities).where(whereClause);
    const total = counted[0]?.value ?? 0;

    return {
      items: rows.map(toSummary),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** Fetch one full opportunity by its public id; null if absent or not publicly visible. */
  async find(publicId: string): Promise<Opportunity | null> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.publicId, publicId),
          eq(opportunities.reviewStatus, "approved"),
          eq(opportunities.isListed, true),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? toStandard(r) : null;
  }

  // ── write path (used by the seed loader, not exposed as a route in M2) ─────────────
  /**
   * Ingest one Standard object. Rejects a record carrying a block that does not match its
   * `fundingType` (the re-cut forbids non-matching blocks), keeps the organization directory in
   * sync, and derives `next_deadline_at` from `deadlines[]` on the way in.
   */
  async upsertFromStandard(
    std: Opportunity,
    opts: {
      reviewStatus?: "pending" | "approved" | "rejected";
      isListed?: boolean;
      sourceSystem?: string;
    } = {},
  ): Promise<void> {
    const { orgs, opp } = fromStandard(std);
    for (const org of orgs) await this.upsertOrganization(org);
    const row: OpportunityInsert = {
      ...opp,
      sourceSystem: opts.sourceSystem ?? null,
      reviewStatus: opts.reviewStatus ?? "approved",
      isListed: opts.isListed ?? true,
      updatedAt: new Date(),
    };
    const { createdAt, ...onUpdate } = row; // preserve the Hub's created timestamp on update
    await this.db
      .insert(opportunities)
      .values(row)
      .onConflictDoUpdate({ target: opportunities.publicId, set: onUpdate });
  }

  private async upsertOrganization(org: OrganizationInsert): Promise<number> {
    const res = await this.db
      .insert(organizations)
      .values(org)
      .onConflictDoUpdate({
        target: organizations.slug,
        set: {
          name: org.name,
          type: org.type,
          description: org.description,
          website: org.website,
          logoUrl: org.logoUrl,
          bannerUrl: org.bannerUrl,
          socialLinks: org.socialLinks,
          ecosystems: org.ecosystems,
          contacts: org.contacts,
          updatedAt: new Date(),
        },
      })
      .returning({ id: organizations.id });
    const created = res[0];
    if (!created) throw new Error(`failed to upsert organization '${org.slug}'`);
    return created.id;
  }
}

export type { OpportunityInsertData };
