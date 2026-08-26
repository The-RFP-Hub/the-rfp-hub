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
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow } from "../../../db/schema.js";
import {
  type ManagedOpportunityQuery,
  type ManagedOpportunityScope,
  type PublisherStatus,
  type Repositories,
  repositories,
} from "../../repositories/index.js";
import type { ManagedOpportunityView, ReviewDecisionSummaryView } from "../../shared/api-views.js";
import type { Principal } from "../../shared/capabilities.js";
import { paginate } from "../../shared/pagination.js";

export type ManagedQuery = ManagedOpportunityQuery;
export type { PublisherStatus };

export interface ManagedPage {
  items: ManagedOpportunityView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export class ManagedOpportunityService {
  private readonly repos: Repositories;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  async listOwned(principal: Principal, query: ManagedQuery): Promise<ManagedPage> {
    return this.list({ kind: "owned", principal }, query);
  }

  /** The review queue. No ownership clause — that IS the difference between the two callers. */
  async listForReview(query: ManagedQuery): Promise<ManagedPage> {
    return this.list({ kind: "review" }, query);
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
    return this.list({ kind: "namespace", slug }, query);
  }

  private async list(scope: ManagedOpportunityScope, query: ManagedQuery): Promise<ManagedPage> {
    const { page, limit, offset } = paginate(query.page ?? 1, query.limit ?? 20);
    const result = await this.repos.opportunities.listManaged(scope, query, limit, offset);
    const total = result.total;

    return {
      items: result.rows.map((row) =>
        toManagedView(
          row.opportunity,
          row.submitterHandle,
          row.survivor,
          reviewDecision(row.lastDecision),
        ),
      ),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** One owned entry, whatever its review status — the route the public detail endpoint 404s. */
  async findOwned(principal: Principal, publicId: string): Promise<OpportunityRow | undefined> {
    return this.repos.opportunities.findOwnedByPublicId(principal, publicId);
  }

  /** One entry by public id, with no visibility clause at all. Reviewer and internal use only. */
  async findAny(publicId: string): Promise<OpportunityRow | undefined> {
    return this.repos.opportunities.findByPublicId(publicId);
  }
}

function reviewDecision(
  row: { action: string; patch: unknown; createdAt: Date } | null,
): ReviewDecisionSummaryView | undefined {
  if (!row) return undefined;
  const reason = (row.patch as { reason?: unknown } | null)?.reason;
  return {
    action: row.action === "reject" ? "reject" : "approve",
    reason: typeof reason === "string" && reason.trim() !== "" ? reason : null,
    at: row.createdAt.toISOString(),
  };
}

export function toManagedView(
  row: OpportunityRow,
  submitterHandle: string | null,
  mergedInto: { id: string; title: string | null } | null,
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
    // Attribution text is not identity: an organisation slug can replace the account handle above.
    submittedByAccountId: row.submittedBy,
    mergedInto,
    lastDecision: lastDecision ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
