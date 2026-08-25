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
import { alias } from "drizzle-orm/pg-core";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type OpportunityRow, accounts, auditLog, opportunities } from "../../../db/schema.js";
import type { ManagedOpportunityView, ReviewDecisionSummaryView } from "../../shared/api-views.js";
import type { Principal } from "../../shared/capabilities.js";
import { paginate } from "../../shared/pagination.js";

export interface ManagedQuery {
  id?: string;
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

  /**
   * Everything filed under ONE namespace, for the organisation's own members.
   *
   * `source_publisher`, not `org_slugs`. The denormalised slug array is the union that includes
   * SPONSORS, and a sponsor is not a publisher: matching on it would show one organisation's
   * unpublished queue to another that merely funds a programme. The same distinction the claim
   * service makes about who may take ownership, applied to who may look.
   */
  async listForNamespace(slug: string, query: ManagedQuery): Promise<ManagedPage> {
    return this.list(eq(opportunities.sourcePublisher, slug), query);
  }

  private async list(scope: SQL | undefined, query: ManagedQuery): Promise<ManagedPage> {
    const { page, limit, offset } = paginate(query.page ?? 1, query.limit ?? 20);
    const where = and(
      scope,
      query.id !== undefined ? eq(opportunities.publicId, query.id) : undefined,
      query.reviewStatus ? eq(opportunities.reviewStatus, query.reviewStatus) : undefined,
    );

    const survivor = alias(opportunities, "managed_survivor");

    const rows = await this.db
      .select({
        opportunity: opportunities,
        submitterHandle: accounts.handle,
        survivor: { id: survivor.publicId, title: survivor.title },
      })
      .from(opportunities)
      .leftJoin(accounts, eq(accounts.id, opportunities.submittedBy))
      .leftJoin(survivor, eq(survivor.id, opportunities.mergedIntoId))
      .where(where)
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.db.select({ value: count() }).from(opportunities).where(where);
    const total = counted[0]?.value ?? 0;
    const decisions = await this.lastDecisions(rows.map((row) => row.opportunity.id));

    return {
      items: rows.map((row) =>
        toManagedView(
          row.opportunity,
          row.submitterHandle,
          row.survivor,
          decisions.get(row.opportunity.id),
        ),
      ),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * The newest approve/reject per entry, for the page that was just read.
   *
   * ONE query for the whole page rather than one per row, and a read rather than a column: the
   * trail already holds this, and a copy on `opportunities` would be a second answer to a question
   * that already has one — wrong the first time a decision is recorded and the copy is not.
   *
   * Ordered the way the trail's own index is (`subject_kind, subject_id, created_at DESC`), plus
   * `id` as the tiebreak so two decisions inside one clock tick still order by the sequence that
   * wrote them; the first row seen per subject is therefore the newest. Kept as an ordered scan
   * rather than `DISTINCT ON` so the query stays inside the query builder and the ordering that
   * makes it correct is the same ordering the index provides.
   */
  private async lastDecisions(ids: number[]): Promise<Map<number, ReviewDecisionSummaryView>> {
    const decisions = new Map<number, ReviewDecisionSummaryView>();
    if (ids.length === 0) return decisions;

    const rows = await this.db
      .select({
        subjectId: auditLog.subjectId,
        action: auditLog.action,
        patch: auditLog.patch,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          inArray(auditLog.subjectId, ids),
          inArray(auditLog.action, ["approve", "reject"]),
        ),
      )
      .orderBy(auditLog.subjectId, desc(auditLog.createdAt), desc(auditLog.id));

    for (const row of rows) {
      // First row per subject wins — the ordering above put the newest there.
      if (decisions.has(row.subjectId)) continue;
      const reason = (row.patch as { reason?: unknown } | null)?.reason;
      decisions.set(row.subjectId, {
        action: row.action === "reject" ? "reject" : "approve",
        reason: typeof reason === "string" && reason.trim() !== "" ? reason : null,
        at: row.createdAt.toISOString(),
      });
    }
    return decisions;
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
  mergedInto: { id: string; title: string } | null,
  lastDecision?: ReviewDecisionSummaryView,
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
    mergedInto,
    lastDecision: lastDecision ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
