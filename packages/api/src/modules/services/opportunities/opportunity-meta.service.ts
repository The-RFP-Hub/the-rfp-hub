/**
 * The sub-resources hanging off one entry: its audit trail, its duplicate pairs and its last
 * verification run.
 *
 * ONE VISIBILITY RULE, APPLIED ONCE. `resolveForViewer` answers both "may this caller see the
 * entry at all" and "may they see the privileged half", and every route below reads that answer
 * rather than re-deciding. A non-public entry 404s for anyone who is not its owner or a reviewer —
 * the same answer the public detail route gives — because a 403 on a sub-resource would confirm the
 * existence of an entry the detail route denies.
 *
 * The duplicates and verification tables are populated by the dedupe and verification waves. Until
 * then an empty list and "no run yet" are the correct, honest answers, not placeholders: an entry
 * that has never been checked genuinely has no run.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityRow,
  opportunities,
  opportunityDuplicates,
  verificationRuns,
} from "../../../db/schema.js";
import type { DuplicateMatchView, VerificationRunView } from "../../shared/api-views.js";
import type { Principal } from "../../shared/capabilities.js";
import { notFound } from "../../shared/http-error.js";

/** What a caller may see of one entry. */
export interface ViewerScope {
  row: OpportunityRow;
  /** Owner (submitter or namespace publisher) or T3+. Unlocks the full audit patch and all pairs. */
  privileged: boolean;
}

export class OpportunityMetaService {
  constructor(private readonly db: DB = defaultDb) {}

  /**
   * The entry, if this caller may see it, plus whether they see the privileged half.
   *
   * Throws 404 — never 403 — when they may not, so the sub-resources leak exactly as much about a
   * pending entry as the detail route does: nothing.
   */
  async resolveForViewer(publicId: string, principal: Principal | null): Promise<ViewerScope> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);

    const privileged = isPrivileged(row, principal);
    const isPublic = row.reviewStatus === "approved" && row.isListed;
    if (!isPublic && !privileged) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    return { row, privileged };
  }

  /**
   * The duplicate pairs naming this entry, from either side.
   *
   * A pair is unordered, so both columns are searched and the OTHER entry is what gets reported.
   * An unprivileged viewer is shown only pairs whose other side is publicly visible — a suspected
   * match must never disclose somebody else's pending title and id.
   */
  async duplicates(scope: ViewerScope): Promise<DuplicateMatchView[]> {
    const other = opportunities;
    const rows = await this.db
      .select({ pair: opportunityDuplicates, other })
      .from(opportunityDuplicates)
      .innerJoin(
        other,
        or(
          and(
            eq(opportunityDuplicates.opportunityId, scope.row.id),
            eq(other.id, opportunityDuplicates.duplicateOfId),
          ),
          and(
            eq(opportunityDuplicates.duplicateOfId, scope.row.id),
            eq(other.id, opportunityDuplicates.opportunityId),
          ),
        ),
      )
      .orderBy(desc(opportunityDuplicates.detectedAt));

    return rows
      .filter(
        ({ other: match }) =>
          scope.privileged || (match.reviewStatus === "approved" && match.isListed),
      )
      .map(({ pair, other: match }) => ({
        id: match.publicId,
        title: match.title,
        similarity: pair.similarity === null ? null : Number(pair.similarity),
        status: pair.status,
        detectedAt: pair.detectedAt.toISOString(),
      }));
  }

  /**
   * Every suspected/decided pair touching an entry this account owns, for the dashboard's queue.
   *
   * The OWNED entry is the one whose side is filtered on; the other side is reported. A pair whose
   * other side is not public is included only because the owner is entitled to know their own entry
   * was flagged — the other entry's title and id are what a stranger must not see, and a stranger
   * does not reach this route.
   */
  async duplicatesForOwner(principal: Principal): Promise<DuplicateMatchView[]> {
    const namespaces = principal.memberships.map((m) => m.slug);
    const ownedIds = this.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(
        namespaces.length === 0
          ? eq(opportunities.submittedBy, principal.accountId)
          : or(
              eq(opportunities.submittedBy, principal.accountId),
              inArray(opportunities.sourcePublisher, namespaces),
            ),
      );
    const mineOnLeft = inArray(opportunityDuplicates.opportunityId, ownedIds);
    const mineOnRight = inArray(opportunityDuplicates.duplicateOfId, ownedIds);

    const other = opportunities;
    const rows = await this.db
      .select({ pair: opportunityDuplicates, other })
      .from(opportunityDuplicates)
      .innerJoin(
        other,
        or(
          and(mineOnLeft, eq(other.id, opportunityDuplicates.duplicateOfId)),
          and(mineOnRight, eq(other.id, opportunityDuplicates.opportunityId)),
        ),
      )
      .orderBy(desc(opportunityDuplicates.detectedAt))
      .limit(100);

    return rows.map(({ pair, other: match }) => ({
      id: match.publicId,
      title: match.title,
      similarity: pair.similarity === null ? null : Number(pair.similarity),
      status: pair.status,
      detectedAt: pair.detectedAt.toISOString(),
    }));
  }

  /** The most recent run, or undefined when the entry has never been checked. */
  async latestVerification(scope: ViewerScope): Promise<VerificationRunView | undefined> {
    const rows = await this.db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.opportunityId, scope.row.id))
      .orderBy(desc(verificationRuns.runAt), desc(verificationRuns.id))
      .limit(1);
    const run = rows[0];
    if (!run) return undefined;
    return {
      runAt: run.runAt.toISOString(),
      requestedUrl: run.requestedUrl,
      finalUrl: run.finalUrl,
      httpStatus: run.httpStatus,
      existsAtSource: run.existsAtSource,
      matched: run.matched,
      fieldDiff: run.fieldDiff,
      extracted: run.extracted,
      snapshotSha256: run.snapshotSha256,
      error: run.error,
    };
  }
}

/** Owner — by submission or by namespace — or a reviewer. The one definition of "privileged". */
export function isPrivileged(row: OpportunityRow, principal: Principal | null): boolean {
  if (!principal) return false;
  // The editorial role is session-only, here as everywhere else: a leaked key must not read the
  // full patch of every entry in the corpus just because its owner is a reviewer.
  if (
    principal.credentialKind === "session" &&
    (principal.role === "reviewer" || principal.role === "admin")
  ) {
    return true;
  }
  if (row.submittedBy === principal.accountId) return true;
  return (
    row.sourcePublisher !== null &&
    principal.memberships.some((m) => m.slug === row.sourcePublisher)
  );
}
