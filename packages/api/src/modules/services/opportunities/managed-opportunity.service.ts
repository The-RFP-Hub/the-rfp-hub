/**
 * The EDITORIAL view of the corpus: entries as their owner and as a reviewer see them, including
 * the pending, rejected and unlisted rows the public reads are pinned away from.
 *
 * `OpportunityService` cannot serve this and must not learn to. Every read it has opens with
 * `review_status='approved' AND is_listed`, and that invariant is the reason the export, the feeds
 * and the list can never disagree about what is public. A parameter that relaxes it would be one
 * `if` away from relaxing it everywhere.
 *
 * "Mine" is deliberately two things: entries this account SUBMITTED, and entries filed under a
 * namespace this account publishes for. The second is what a granted claim transfers — ownership
 * follows the namespace, not the original typist.
 */
import { type SQL, and, count, desc, eq, inArray, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type OpportunityRow, accounts, opportunities } from "../../../db/schema.js";
import type { ManagedOpportunityView } from "../../shared/api-views.js";
import type { Principal } from "../../shared/capabilities.js";
import { paginate } from "../../shared/pagination.js";

export interface ManagedQuery {
  reviewStatus?: "pending" | "approved" | "rejected";
  page?: number;
  limit?: number;
}

export interface ManagedPage {
  items: ManagedOpportunityView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export class ManagedOpportunityService {
  constructor(private readonly db: DB = defaultDb) {}

  /** The predicate for "entries this principal owns". Undefined memberships narrow it, never widen. */
  private ownership(principal: Principal): SQL | undefined {
    const namespaces = principal.memberships.map((m) => m.slug);
    const mine = eq(opportunities.submittedBy, principal.accountId);
    if (namespaces.length === 0) return mine;
    return or(mine, inArray(opportunities.sourcePublisher, namespaces));
  }

  async listOwned(principal: Principal, query: ManagedQuery): Promise<ManagedPage> {
    return this.list(this.ownership(principal), query);
  }

  /** The review queue. No ownership clause — that IS the difference between the two callers. */
  async listForReview(query: ManagedQuery): Promise<ManagedPage> {
    return this.list(undefined, query);
  }

  private async list(scope: SQL | undefined, query: ManagedQuery): Promise<ManagedPage> {
    const { page, limit, offset } = paginate(query.page ?? 1, query.limit ?? 20);
    const where = and(
      scope,
      query.reviewStatus ? eq(opportunities.reviewStatus, query.reviewStatus) : undefined,
    );

    const rows = await this.db
      .select({ opportunity: opportunities, submitterHandle: accounts.handle })
      .from(opportunities)
      .leftJoin(accounts, eq(accounts.id, opportunities.submittedBy))
      .where(where)
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.db.select({ value: count() }).from(opportunities).where(where);
    const total = counted[0]?.value ?? 0;

    return {
      items: rows.map((row) => toManagedView(row.opportunity, row.submitterHandle)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** One owned entry, whatever its review status — the route the public detail endpoint 404s. */
  async findOwned(principal: Principal, publicId: string): Promise<OpportunityRow | undefined> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.publicId, publicId), this.ownership(principal)))
      .limit(1);
    return rows[0];
  }

  /** One entry by public id, with no visibility clause at all. Reviewer and internal use only. */
  async findAny(publicId: string): Promise<OpportunityRow | undefined> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    return rows[0];
  }
}

export function toManagedView(
  row: OpportunityRow,
  submitterHandle: string | null,
): ManagedOpportunityView {
  return {
    id: row.publicId,
    title: row.title,
    fundingType: row.fundingType,
    status: row.status,
    reviewStatus: row.reviewStatus,
    isListed: row.isListed,
    namespace: row.sourcePublisher,
    // The stored attribution string, falling back to the submitting account's handle: an entry
    // published as an organisation is credited to the organisation, and that is what belongs here.
    submittedBy: row.sourceSubmittedBy ?? submitterHandle,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
