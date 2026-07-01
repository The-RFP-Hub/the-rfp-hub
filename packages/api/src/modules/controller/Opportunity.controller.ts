import type { Opportunity, OpportunityStatus, OpportunityType } from "@rfp-hub/standard";
import {
  type SQL,
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import {
  type OpportunityInsert,
  type OrganizationInsert,
  opportunities,
  organizations,
} from "../../db/schema.js";
import { DrizzleController } from "../abstract/Drizzle.controller.js";
import {
  type OpportunityInsertData,
  fromStandard,
  toStandard,
  toSummary,
} from "../mappers/opportunity.mapper.js";

export type SortField = "closesAt" | "opensAt" | "postedAt" | "updatedAt" | "createdAt";

/** Normalized query for the list endpoint (produced by routes/opportunities/types.ts). */
export interface OpportunityQuery {
  type?: OpportunityType[];
  status?: OpportunityStatus[];
  ecosystem?: string[];
  network?: string[];
  category?: string[];
  tag?: string[];
  organization?: string;
  minAward?: number;
  maxAward?: number;
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
  closesAt: opportunities.closesAt,
  opensAt: opportunities.opensAt,
  postedAt: opportunities.postedAt,
  updatedAt: opportunities.updatedAt,
  createdAt: opportunities.createdAt,
} as const;

/** Data + business logic for opportunities. Public reads are always approved + listed. */
export class OpportunityController extends DrizzleController {
  /** Conditions shared by every public read. */
  private liveFilters(q: OpportunityQuery): SQL[] {
    const where: SQL[] = [
      eq(opportunities.reviewStatus, "approved"),
      eq(opportunities.isListed, true),
    ];
    if (q.type?.length) where.push(inArray(opportunities.type, q.type));
    if (q.status?.length) where.push(inArray(opportunities.status, q.status));
    if (q.ecosystem?.length) where.push(arrayOverlaps(opportunities.ecosystems, q.ecosystem));
    if (q.network?.length) where.push(arrayOverlaps(opportunities.networks, q.network));
    if (q.category?.length) where.push(arrayOverlaps(opportunities.categories, q.category));
    if (q.tag?.length) where.push(arrayOverlaps(opportunities.tags, q.tag));
    if (q.organization) where.push(eq(organizations.slug, q.organization));
    // Include the same-side bound so a row that sets only one of min/max/budget still matches.
    if (q.minAward !== undefined) {
      where.push(
        sql`coalesce(${opportunities.maxAward}, ${opportunities.totalBudget}, ${opportunities.minAward}) >= ${q.minAward}`,
      );
    }
    if (q.maxAward !== undefined) {
      where.push(
        sql`coalesce(${opportunities.minAward}, ${opportunities.totalBudget}, ${opportunities.maxAward}) <= ${q.maxAward}`,
      );
    }
    if (q.q) {
      const like = `%${q.q}%`;
      const text = or(
        ilike(opportunities.title, like),
        ilike(opportunities.summary, like),
        ilike(opportunities.description, like),
      );
      if (text) where.push(text);
    }
    return where;
  }

  /** List opportunities (thin projection) with filters, sort and pagination. */
  async getAll(q: OpportunityQuery): Promise<Page<Opportunity>> {
    const { page, limit, offset } = this.paginate(q.page, q.limit);
    const whereClause = and(...this.liveFilters(q));
    const sortCol = SORT_COLUMNS[q.sort];
    const primary = q.order === "asc" ? asc(sortCol) : desc(sortCol);

    const rows = await this.db
      .select()
      .from(opportunities)
      .innerJoin(organizations, eq(opportunities.organizationId, organizations.id))
      .where(whereClause)
      .orderBy(primary, desc(opportunities.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.db
      .select({ value: count() })
      .from(opportunities)
      .innerJoin(organizations, eq(opportunities.organizationId, organizations.id))
      .where(whereClause);
    const total = counted[0]?.value ?? 0;

    return {
      items: rows.map((r) => toSummary(r.opportunities, r.organizations)),
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
      .innerJoin(organizations, eq(opportunities.organizationId, organizations.id))
      .where(
        and(
          eq(opportunities.publicId, publicId),
          eq(opportunities.reviewStatus, "approved"),
          eq(opportunities.isListed, true),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? toStandard(r.opportunities, r.organizations) : null;
  }

  // ── write path (used by the seed loader, not exposed as a route in M2) ─────────────
  async upsertFromStandard(
    std: Opportunity,
    opts: {
      reviewStatus?: "pending" | "approved" | "rejected";
      isListed?: boolean;
      sourceSystem?: string;
    } = {},
  ): Promise<void> {
    const { org, opp } = fromStandard(std);
    const organizationId = await this.upsertOrganization(org);
    const row: OpportunityInsert = {
      ...opp,
      organizationId,
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
