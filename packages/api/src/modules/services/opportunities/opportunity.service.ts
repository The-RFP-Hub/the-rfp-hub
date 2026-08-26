import type { Opportunity } from "@the-rfp-hub/standard";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityInsert } from "../../../db/schema.js";
import {
  type OpportunityInsertData,
  type OpportunitySummary,
  fromStandard,
  toStandard,
  toSummary,
} from "../../mappers/opportunity.mapper.js";
import {
  type PublicOpportunityQuery,
  type Repositories,
  repositories,
} from "../../repositories/index.js";
import { paginate } from "../../shared/pagination.js";

/**
 * Sortable fields. `closesAt` is gone with the re-cut — `nextDeadlineAt` (the derived, denormalized
 * earliest FUTURE fixed deadline) replaces it and is the default.
 */
export type { OpportunitySortField as SortField } from "../../repositories/index.js";

/** Normalized query for the list endpoint (produced by routes/opportunities/types.ts). */
export type OpportunityQuery = PublicOpportunityQuery;

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Escape Postgres LIKE/ILIKE metacharacters (%, _, \) so user text matches literally.
 * Patterns are parameter-bound (no injection) — this is precision only. Backslash is Postgres's
 * default ILIKE escape char, so no explicit ESCAPE clause is required.
 */
export { escapeLike } from "../../repositories/index.js";

/** Data + business logic for opportunities. Public reads are always approved + listed. */
export class OpportunityService {
  private readonly repos: Repositories;

  constructor(db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  /** List opportunities (thin projection) with filters, sort and pagination. */
  async getAll(q: OpportunityQuery): Promise<Page<OpportunitySummary>> {
    const { page, limit, offset } = paginate(q.page, q.limit);
    const result = await this.repos.opportunities.listPublic(q, limit, offset);
    const total = result.total;

    return {
      items: result.rows.map(toSummary),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * EVERY publicly visible record, as full Standard objects — no filters, no pagination.
   *
   * The one unbounded read in this service, and it exists because the dataset is published whole:
   * the open-data export writes it to files and `/v1/export/*` streams it to a caller. Both go
   * through here rather than each running its own `select`, so the two can never disagree about
   * which rows are public — that predicate is `approved AND is_listed`, the same invariant
   * `liveFilters` opens every other public read with.
   *
   * Ordered by `public_id` at the database, which is a stable, index-backed order to read in; the
   * PUBLISHED order is not this one and is not a database concern — `orderForExport` imposes it on
   * the records afterwards, identically for every consumer (see modules/shared/export-format.ts).
   */
  async listAll(): Promise<Opportunity[]> {
    const rows = await this.repos.opportunities.listAllPublic();
    return rows.map(toStandard);
  }

  /** Fetch one full opportunity by its public id; null if absent or not publicly visible. */
  async find(publicId: string): Promise<Opportunity | null> {
    const r = await this.repos.opportunities.findPublicDetailByPublicId(publicId);
    return r ? toStandard(r) : null;
  }

  /** Public link-out value, still subject to protocol validation by the redirect controller. */
  async findLink(publicId: string, kind: "apply" | "source"): Promise<string | null> {
    const row = await this.repos.opportunities.findPublicDetailByPublicId(publicId);
    return (kind === "apply" ? row?.applicationUrl : row?.website) ?? null;
  }

  /**
   * Resolve a merged public id without weakening the public-read predicate.
   *
   * The loser's terminal row is never returned. Its destination is disclosed only when that id was
   * public at merge time and the survivor remains public now; every other miss stays indistinguishable
   * from an id that never existed.
   */
  async findMergedDestination(publicId: string): Promise<{ id: string; title: string } | null> {
    return this.repos.opportunities.findMergedDestinationByPublicId(publicId);
  }

  // ── write path (used by the seed loader, not exposed as a route in M2) ─────────────
  /**
   * Ingest one Standard object. Stores `fundingDetails` tag-free as `type_data` (the read path
   * reattaches the tag from the `funding_type` column, so a mismatched inner tag cannot survive
   * ingest), keeps the organization directory in sync, and derives `next_deadline_at` from
   * `deadlines[]` on the way in. Callers validate upstream (the seed's `gateForSeed`).
   */
  async upsertFromStandard(
    std: Opportunity,
    opts: {
      reviewStatus?: "pending" | "approved" | "rejected";
      isListed?: boolean;
      sourceSystem?: string;
    } = {},
  ): Promise<void> {
    await upsertOpportunityFromStandard(this.repos, std, opts);
  }
}

/** Repository-bundle form used by the atomic seed batch and the pool-bound service method. */
export async function upsertOpportunityFromStandard(
  repos: Repositories,
  std: Opportunity,
  opts: {
    reviewStatus?: "pending" | "approved" | "rejected";
    isListed?: boolean;
    sourceSystem?: string;
  } = {},
): Promise<void> {
  const { orgs, opp } = fromStandard(std);
  for (const org of orgs) await repos.organizations.upsertFromIngest(org);
  const row: OpportunityInsert = {
    ...opp,
    sourceSystem: opts.sourceSystem ?? null,
    reviewStatus: opts.reviewStatus ?? "approved",
    isListed: opts.isListed ?? true,
    updatedAt: new Date(),
  };
  await repos.opportunities.upsertByPublicId(row);
}

export type { OpportunityInsertData };
