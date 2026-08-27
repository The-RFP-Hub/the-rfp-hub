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
  withTransaction,
} from "../../repositories/index.js";
import { comparableImportedOpportunity } from "../../shared/opportunity-content.js";
import { paginate } from "../../shared/pagination.js";
import { diffFields, isEmptyPatch } from "../../shared/patch.js";
import { SYSTEM_ACTOR } from "../audit/audit.service.js";

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
  /**
   * Kept alongside the pool-bound bundle because the write path needs to OPEN a transaction, which
   * `repositories(db)` deliberately cannot do — `withTransaction` is the only way to get an
   * executor-bound bundle, and it needs the client. Reads stay on `this.repos`.
   */
  private readonly db: DB;

  constructor(db: DB = defaultDb) {
    this.db = db;
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
   * ingest), keeps the organization directory in sync, derives `next_deadline_at` from
   * `deadlines[]` on the way in, and APPENDS AN AUDIT ROW when the write actually changed
   * something. Callers validate upstream (the seed's `gateForSeed`).
   *
   * ATOMIC, like the seed's batch form. The pre-image lock, the organization upserts, the
   * opportunity upsert and the history row are one decision or none: on the pool-bound bundle they
   * would commit independently, so a failure between the upsert and the audit insert would leave
   * exactly the unaudited row this whole change exists to prevent — and the `FOR UPDATE` taken to
   * make the diff trustworthy would be released before the write it was guarding.
   */
  async upsertFromStandard(
    std: Opportunity,
    opts: {
      reviewStatus?: "pending" | "approved" | "rejected";
      isListed?: boolean;
      sourceSystem?: string;
    } = {},
  ): Promise<void> {
    await withTransaction(this.db, (repos) => upsertOpportunityFromStandard(repos, std, opts));
  }
}

/**
 * The `patch` key every row written by this path carries, and the reason it is a patch key rather
 * than an `audit_action` of its own.
 *
 * `audit_action` is a closed vocabulary (see its comment in `db/schema.ts`), and an `import` verb
 * cannot be added to it without breaking the backfill migration that ships with this change:
 * Drizzle's migrator runs every pending migration in ONE transaction, and PostgreSQL refuses to use
 * an enum value added by the transaction still adding it. So the path is named in the patch, the
 * same way the staleness job names itself — `patch->>'job'` identifies the writer, `action` stays
 * the verb.
 */
const IMPORT_JOB = "import";

/** Repository-bundle form. Both callers hold a transaction: the seed batch, and the method above. */
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
  const sourceSystem = opts.sourceSystem ?? null;
  const row: OpportunityInsert = {
    ...opp,
    sourceSystem,
    reviewStatus: opts.reviewStatus ?? "approved",
    isListed: opts.isListed ?? true,
    updatedAt: new Date(),
  };

  /**
   * The pre-image, read UNDER A ROW LOCK and with the same handle the upsert will use.
   *
   * The lock is what makes "read the old content, write the new, diff the two" a single decision.
   * Without it two concurrent re-imports of the same id both read the same pre-image, both upsert,
   * and both append a row claiming to be the one that changed it. `FOR UPDATE` cannot lock a row
   * that does not exist yet, so two concurrent FIRST imports can still both read nothing — but there
   * the upsert's `ON CONFLICT` collapses them and the worst outcome is two `create` rows for one
   * entry, which over-reports rather than lying.
   */
  const before = await repos.opportunities.lockByPublicId(std.id);
  const stored = await repos.opportunities.upsertByPublicId(row);
  if (!stored) throw new Error(`failed to persist ${std.id}`);

  /**
   * NOTHING CHANGED, NOTHING RECORDED.
   *
   * The seed is re-run whenever the corpus file moves, and the corpus is mostly unchanged every
   * time. A history row per entry per run would bury the handful of real edits under thousands of
   * rows saying nothing happened — and `audit_log` is append-only, so that is not a mistake anyone
   * can tidy up afterwards.
   *
   * "Changed" is the submission path's content projection PLUS the three fields this path decides
   * for itself (`review_status`, `is_listed`, `source_system`) — see `IMPORT_OWNED`. Sharing the
   * content half keeps the two paths from disagreeing about whether a document was edited; adding
   * the other three is required because no route audits them on this path, so a re-import that
   * approved or relisted an entry would otherwise pass as a no-op. What stays excluded is what
   * genuinely moves on every run regardless: `updated_at`, `last_seen_at`, and the
   * `next_deadline_at` this upsert recomputes from `now()`.
   */
  const patch = diffFields(
    before ? comparableImportedOpportunity(before) : {},
    comparableImportedOpportunity(stored),
  );
  if (before && isEmptyPatch(patch)) return;

  await repos.audit.record({
    // The seed loader and the offline importers act on nobody's behalf: there is no account behind
    // a corpus file, and attributing one would be an invention.
    ...SYSTEM_ACTOR,
    subjectKind: "opportunity",
    subjectId: stored.id,
    // `create` for the first sighting, `update` for a content-changing re-import — the verbs the
    // closed enum already has. `IMPORT_JOB` above says why there is no `import` verb.
    action: before ? "update" : "create",
    // `job` names the writer; the diff carries everything else. `sourceSystem` is IN the diff now
    // rather than restated beside it as a bare string: restating it would either clobber the
    // before/after pair on the run that actually moved an entry between source systems, or leave
    // one key holding two different shapes and `patch->>'sourceSystem'` meaning two things.
    patch: { ...patch, job: IMPORT_JOB },
  });
}

export type { OpportunityInsertData };
