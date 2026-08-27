import type { FundingType, OpportunityStatus } from "@the-rfp-hub/standard";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn, type PgColumn, alias } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import {
  type OpportunityInsert,
  type OpportunityRow,
  accounts,
  auditLog,
  opportunities,
} from "../../../db/schema.js";
import type { Principal } from "../../shared/capabilities.js";

/**
 * Sortable fields. `closesAt` is gone with the re-cut — `nextDeadlineAt` (the derived, denormalized
 * earliest FUTURE fixed deadline) replaces it and is the default.
 */
export type OpportunitySortField =
  | "nextDeadlineAt"
  | "opensAt"
  | "postedAt"
  | "updatedAt"
  | "createdAt";

/** Normalized query for the public list endpoint. */
export interface PublicOpportunityQuery {
  fundingType?: FundingType[];
  status?: OpportunityStatus[];
  ecosystem?: string[];
  category?: string[];
  /** Organization slug — matches ANY operating OR sponsoring organization, not only the primary one. */
  organization?: string;
  minAward?: number;
  maxAward?: number;
  /** Deadline window over `next_deadline_at` (ISO instants). Rolling-only records are excluded. */
  deadlineAfter?: Date;
  deadlineBefore?: Date;
  q?: string;
  sort: OpportunitySortField;
  order: "asc" | "desc";
  page: number;
  limit: number;
}

export type PublisherStatus = "merged" | "rejected" | "pending" | "hidden" | "live";

export interface ManagedOpportunityQuery {
  id?: string;
  reviewStatus?: "pending" | "approved" | "rejected";
  publisherStatus?: PublisherStatus;
  page?: number;
  limit?: number;
}

export type ManagedOpportunityScope =
  | { kind: "owned"; principal: Principal }
  | { kind: "review" }
  | { kind: "namespace"; slug: string };

export interface OwnershipColumns {
  submittedBy: AnyPgColumn;
  sourcePublisher: AnyPgColumn;
}

export interface ClaimPublisherUpdate {
  sourcePublisher: string;
  sourceSubmittedBy: string;
  lastSeenAt: Date;
  reviewStatus: OpportunityRow["reviewStatus"];
  approvedBy: number | null;
  approvedAt: Date | null;
  updatedAt: Date;
}

/** SQL form of submission-or-namespace ownership, usable with the table or one of its aliases. */
export function ownedOpportunityPredicate(
  opportunity: OwnershipColumns,
  principal: Principal,
): SQL {
  const namespaces = principal.memberships.map((membership) => membership.slug);
  if (namespaces.length === 0) return eq(opportunity.submittedBy, principal.accountId);
  return or(
    eq(opportunity.submittedBy, principal.accountId),
    inArray(opportunity.sourcePublisher, namespaces),
  ) as SQL;
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

/**
 * "Does this text[] column contain any of these values, ignoring case?"
 *
 * THE INDEX TRADEOFF, stated rather than discovered later. `&&` (`arrayOverlaps`) is served by the
 * GIN index on these columns; `lower(x)` cannot be, because the index holds the values as written.
 * So this predicate is a scan over the row's own array — a few elements per row — and the planner
 * falls back to a sequential scan on the table where `&&` would have used the index.
 *
 * Accepted deliberately: the corpus is small (hundreds of rows, bounded by what a review queue can
 * pass), the arrays are short, and the alternative is a filter that quietly answers with a subset of
 * the matching rows. If this table ever grows enough for it to matter, the fix is an expression
 * index on `lower()` over the unnested values — a functional GIN index — not re-narrowing the query.
 */
function arrayMatchesInsensitive(column: PgColumn, values: string[]): SQL {
  const lowered = sql.join(
    values.map((value) => sql`${value.trim().toLowerCase()}`),
    sql`, `,
  );
  return sql`exists (select 1 from unnest(${column}) as candidate where lower(candidate) in (${lowered}))`;
}

export class OpportunityRepository {
  constructor(private readonly exec: DbLike) {}

  async listPublic(q: PublicOpportunityQuery, limit: number, offset: number) {
    const whereClause = and(...this.liveFilters(q));
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(whereClause)
      .orderBy(this.publicOrder(q), desc(opportunities.id))
      .limit(limit)
      .offset(offset);
    const counted = await this.exec
      .select({ value: count() })
      .from(opportunities)
      .where(whereClause);
    return { rows, total: counted[0]?.value ?? 0 };
  }

  async listAllPublic() {
    return this.exec
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true)))
      .orderBy(asc(opportunities.publicId));
  }

  async findByPublicId(publicId: string) {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    return rows[0];
  }

  async findById(id: number): Promise<OpportunityRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .limit(1);
    return rows[0];
  }

  async lockById(id: number): Promise<OpportunityRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async lockByPublicId(publicId: string): Promise<OpportunityRow | undefined> {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async countPendingBySubmitter(accountId: number): Promise<number> {
    const counted = await this.exec
      .select({ value: count() })
      .from(opportunities)
      .where(
        and(eq(opportunities.submittedBy, accountId), eq(opportunities.reviewStatus, "pending")),
      );
    return counted[0]?.value ?? 0;
  }

  async insert(values: OpportunityInsert): Promise<OpportunityRow | undefined> {
    const rows = await this.exec.insert(opportunities).values(values).returning();
    return rows[0];
  }

  /**
   * Idempotent seed ingest; preserve the Hub's original creation timestamp on conflict.
   *
   * RETURNS THE STORED ROW, on both arms of the conflict. The caller has to audit what it wrote,
   * and it cannot: it does not know the surrogate id of a row it may have just inserted, and
   * re-reading afterwards would be a second round trip answering a question this statement already
   * has the answer to.
   */
  async upsertByPublicId(values: OpportunityInsert): Promise<OpportunityRow | undefined> {
    const { createdAt, ...onUpdate } = values;
    const rows = await this.exec
      .insert(opportunities)
      .values(values)
      .onConflictDoUpdate({ target: opportunities.publicId, set: onUpdate })
      .returning();
    return rows[0];
  }

  async update(
    id: number,
    values: Partial<OpportunityInsert>,
  ): Promise<OpportunityRow | undefined> {
    const rows = await this.exec
      .update(opportunities)
      .set(values)
      .where(eq(opportunities.id, id))
      .returning();
    return rows[0];
  }

  async applyVerification(
    id: number,
    values: {
      verifiedAgainstSource: boolean;
      verifiedAt: Date;
      lastSeenAt: Date | null;
    },
  ): Promise<void> {
    await this.exec.update(opportunities).set(values).where(eq(opportunities.id, id));
  }

  async updateClaimPublisher(id: number, values: ClaimPublisherUpdate): Promise<void> {
    await this.exec.update(opportunities).set(values).where(eq(opportunities.id, id));
  }

  /**
   * Entries owed a source check, NEVER-CHECKED FIRST.
   *
   * The order is the whole reason this is not `ORDER BY id`. `limit` is a nightly cap, so when the
   * predicate matches more than the cap the order decides who is dropped — and an entry nobody has
   * ever fetched is worth more than one whose check is a month old. `verified_at ASC NULLS FIRST`
   * puts the never-checked at the head and then works through the stalest; `id` breaks ties so a
   * capped run is deterministic rather than at the planner's discretion.
   */
  async listPendingVerificationIds(limit: number, recheckBefore: Date | null): Promise<number[]> {
    const rows = await this.exec
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(this.pendingVerificationFilter(recheckBefore))
      .orderBy(sql`${opportunities.verifiedAt} asc nulls first`, asc(opportunities.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async countPendingVerification(recheckBefore: Date | null): Promise<number> {
    const rows = await this.exec
      .select({ value: count() })
      .from(opportunities)
      .where(this.pendingVerificationFilter(recheckBefore));
    return rows[0]?.value ?? 0;
  }

  async listStalenessCandidates(
    now: Date,
    afterId: number,
    limit: number,
  ): Promise<OpportunityRow[]> {
    return this.exec
      .select()
      .from(opportunities)
      .where(this.stalenessCandidateFilter(now, afterId))
      .orderBy(asc(opportunities.id))
      .limit(limit);
  }

  async countStalenessCandidates(now: Date, afterId: number): Promise<number> {
    const rows = await this.exec
      .select({ value: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(this.stalenessCandidateFilter(now, afterId));
    return rows[0]?.value ?? 0;
  }

  async updateNextDeadline(id: number, nextDeadlineAt: Date | null): Promise<void> {
    await this.exec.update(opportunities).set({ nextDeadlineAt }).where(eq(opportunities.id, id));
  }

  async closeForStaleness(id: number, nextDeadlineAt: Date | null): Promise<void> {
    await this.exec
      .update(opportunities)
      // `updated_at` deliberately absent — see StalenessService's header.
      .set({ status: "closed", nextDeadlineAt })
      .where(eq(opportunities.id, id));
  }

  async findPublicDetailByPublicId(publicId: string) {
    const rows = await this.exec
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
    return rows[0];
  }

  async findMergedDestinationByPublicId(publicId: string) {
    const survivor = alias(opportunities, "public_merge_survivor");
    const rows = await this.exec
      .select({ id: survivor.publicId, title: survivor.title })
      .from(opportunities)
      .innerJoin(survivor, eq(survivor.id, opportunities.mergedIntoId))
      .where(
        and(
          eq(opportunities.publicId, publicId),
          eq(opportunities.mergedFromPublic, true),
          eq(survivor.reviewStatus, "approved"),
          eq(survivor.isListed, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listManaged(
    scope: ManagedOpportunityScope,
    query: ManagedOpportunityQuery,
    limit: number,
    offset: number,
  ) {
    const where = and(
      this.managedScope(scope),
      query.id !== undefined ? eq(opportunities.publicId, query.id) : undefined,
      query.reviewStatus ? eq(opportunities.reviewStatus, query.reviewStatus) : undefined,
      publisherStatusPredicate(query.publisherStatus),
    );
    const survivor = alias(opportunities, "managed_survivor");
    // The newest approve/reject per entry. The second audit alias excludes every decision that has
    // a later timestamp, or a larger id in the same clock tick, leaving exactly the row the old
    // ordered scan selected first. The trail remains the sole answer; opportunities carries no copy.
    const lastDecision = alias(auditLog, "managed_last_decision");
    const laterDecision = alias(auditLog, "managed_later_decision");

    const rows = await this.exec
      .select({
        opportunity: opportunities,
        submitterHandle: accounts.handle,
        survivor: {
          id: survivor.publicId,
          // The merge audit already entitles an owner to the survivor's id. Its current title is
          // public data only while the survivor itself satisfies the public-read invariant.
          title: sql<string | null>`case
            when ${survivor.reviewStatus} = 'approved' and ${survivor.isListed}
            then ${survivor.title}
            else null
          end`,
        },
        lastDecision: {
          action: lastDecision.action,
          patch: lastDecision.patch,
          createdAt: lastDecision.createdAt,
        },
      })
      .from(opportunities)
      .leftJoin(accounts, eq(accounts.id, opportunities.submittedBy))
      .leftJoin(survivor, eq(survivor.id, opportunities.mergedIntoId))
      .leftJoin(
        lastDecision,
        and(
          eq(lastDecision.subjectKind, "opportunity"),
          eq(lastDecision.subjectId, opportunities.id),
          inArray(lastDecision.action, ["approve", "reject"]),
        ),
      )
      .leftJoin(
        laterDecision,
        and(
          eq(laterDecision.subjectKind, "opportunity"),
          eq(laterDecision.subjectId, opportunities.id),
          inArray(laterDecision.action, ["approve", "reject"]),
          or(
            gt(laterDecision.createdAt, lastDecision.createdAt),
            and(
              eq(laterDecision.createdAt, lastDecision.createdAt),
              gt(laterDecision.id, lastDecision.id),
            ),
          ),
        ),
      )
      .where(and(where, isNull(laterDecision.id)))
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.exec.select({ value: count() }).from(opportunities).where(where);
    return { rows, total: counted[0]?.value ?? 0 };
  }

  async findOwnedByPublicId(principal: Principal, publicId: string) {
    const rows = await this.exec
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.publicId, publicId),
          ownedOpportunityPredicate(opportunities, principal),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async stats() {
    const live = and(eq(opportunities.reviewStatus, "approved"), eq(opportunities.isListed, true));
    const [totalRows, byFundingType, byStatus, ecoRes, updatedRows] = await Promise.all([
      this.exec.select({ value: count() }).from(opportunities).where(live),
      this.exec
        .select({ key: opportunities.fundingType, value: count() })
        .from(opportunities)
        .where(live)
        .groupBy(opportunities.fundingType),
      this.exec
        .select({ key: opportunities.status, value: count() })
        .from(opportunities)
        .where(live)
        .groupBy(opportunities.status),
      this.exec.execute(sql`
        SELECT e AS ecosystem, count(*)::int AS count
        FROM ${opportunities}, unnest(${opportunities.ecosystems}) AS e
        WHERE ${live}
        GROUP BY e
        ORDER BY count DESC, e ASC
        LIMIT 10
      `),
      this.exec
        .select({ value: max(opportunities.updatedAt) })
        .from(opportunities)
        .where(live),
    ]);
    const ecosystemRows = ecoRes.rows as { ecosystem: string; count: number }[];
    return { totalRows, byFundingType, byStatus, ecosystemRows, updatedRows };
  }

  /** Conditions shared by every public read. */
  private liveFilters(q: PublicOpportunityQuery): SQL[] {
    const where: SQL[] = [
      eq(opportunities.reviewStatus, "approved"),
      eq(opportunities.isListed, true),
    ];
    if (q.fundingType?.length) where.push(inArray(opportunities.fundingType, q.fundingType));
    if (q.status?.length) where.push(inArray(opportunities.status, q.status));
    // CASE-INSENSITIVE, unlike `fundingType`/`status` above (closed, validated enums, so an exact
    // match is correct there): an ecosystem name is free text a publisher types, so the corpus
    // really does hold `Ethereum`, `ethereum` and `EVM`/`evm` side by side, and a case-sensitive
    // `&&` answered a query for one of them with a fraction of the rows and no indication that it
    // had. A filter that silently returns a subset is worse than one that returns nothing.
    if (q.ecosystem?.length)
      where.push(arrayMatchesInsensitive(opportunities.ecosystems, q.ecosystem));
    // CASE-INSENSITIVE, same reasoning as ecosystem above. `categories[]` is explicitly "Free text"
    // in the Standard (schemas/v1.0.0/opportunity.schema.json) — NOT a closed, registry-governed
    // vocabulary — so the corpus holds `Infrastructure` and `infrastructure` side by side just like
    // an ecosystem name does, and a case-sensitive `&&` silently returned a subset for one spelling.
    if (q.category?.length)
      where.push(arrayMatchesInsensitive(opportunities.categories, q.category));
    // ANY operating OR sponsoring organization, via the denormalized slug array — also
    // case-insensitively, because a slug arrives in a URL a human typed as often as from a link.
    if (q.organization) {
      where.push(arrayMatchesInsensitive(opportunities.orgSlugs, [q.organization]));
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
  private publicOrder(q: PublicOpportunityQuery): SQL {
    const column = SORT_COLUMNS[q.sort];
    return q.order === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
  }

  private managedScope(scope: ManagedOpportunityScope): SQL | undefined {
    switch (scope.kind) {
      case "owned":
        return ownedOpportunityPredicate(opportunities, scope.principal);
      case "review":
        return undefined;
      case "namespace":
        return eq(opportunities.sourcePublisher, scope.slug);
    }
  }

  /**
   * Owed a check: has a URL to fetch, is not a merged-away duplicate, and one of three things is
   * true — never checked, edited since its last check, or that check has simply gone stale.
   *
   * THE THIRD CLAUSE IS THE ONE THAT KEEPS THE CORPUS ALIVE. Without it the first two retire an
   * entry permanently: `applyVerification` deliberately does not touch `updated_at` (a bump would
   * reset the staleness clock and re-queue the row forever), so once `verified_at` is set,
   * `verified_at < updated_at` is false and stays false. A seeded, never-edited entry was therefore
   * checked exactly once, in the week it was imported, and never looked at again — while
   * `staleness` closes rolling and no-deadline entries whose `coalesce(last_seen_at, updated_at)`
   * is 90 days old, and only a MATCHED check refreshes `last_seen_at`. One check, then silence,
   * then a mass auto-close ninety days later.
   *
   * `recheckBefore` is `now - VERIFY_RECHECK_DAYS`. NULL disables the TTL clause entirely, which is
   * what a caller asking "what is owed a check on the old rules?" wants.
   */
  private pendingVerificationFilter(recheckBefore: Date | null): SQL | undefined {
    const owed = [
      isNull(opportunities.verifiedAt),
      sql`${opportunities.verifiedAt} < ${opportunities.updatedAt}`,
      ...(recheckBefore === null ? [] : [lt(opportunities.verifiedAt, recheckBefore)]),
    ];
    return and(
      isNotNull(opportunities.applicationUrl),
      isNull(opportunities.mergedIntoId),
      or(...owed),
    );
  }

  private stalenessCandidateFilter(now: Date, afterId: number): SQL | undefined {
    return and(
      eq(opportunities.status, "open"),
      isNull(opportunities.mergedIntoId),
      or(isNull(opportunities.nextDeadlineAt), lte(opportunities.nextDeadlineAt, now)),
      gt(opportunities.id, afterId),
    );
  }
}

/** The five mutually exclusive publisher states. Merged and rejected facts take precedence. */
function publisherStatusPredicate(status: PublisherStatus | undefined): SQL | undefined {
  if (status === undefined) return undefined;
  switch (status) {
    case "merged":
      return isNotNull(opportunities.mergedIntoId);
    case "rejected":
      return and(isNull(opportunities.mergedIntoId), eq(opportunities.reviewStatus, "rejected"));
    case "pending":
      return and(isNull(opportunities.mergedIntoId), eq(opportunities.reviewStatus, "pending"));
    case "hidden":
      return and(
        isNull(opportunities.mergedIntoId),
        eq(opportunities.reviewStatus, "approved"),
        eq(opportunities.isListed, false),
      );
    case "live":
      return and(
        isNull(opportunities.mergedIntoId),
        eq(opportunities.reviewStatus, "approved"),
        eq(opportunities.isListed, true),
      );
  }
}
