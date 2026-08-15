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
  /** Owner (submitter or namespace publisher) or T3+. Unlocks THIS entry's full audit patch. */
  privileged: boolean;
  /**
   * T3+ on a session, and nobody else.
   *
   * Kept apart from `privileged` because the two answer different questions. `privileged` is
   * "may this caller see the private half of THIS entry" — an owner may. Whether the caller may
   * see the private half of a DIFFERENT entry, which is what the other side of a duplicate pair
   * is, is a separate question, and the owner's answer to it is no.
   */
  reviewer: boolean;
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
    return { row, privileged, reviewer: isReviewer(principal) };
  }

  /**
   * The duplicate pairs naming this entry, from either side.
   *
   * A pair is unordered, so both columns are searched and the OTHER entry is what gets reported.
   * Only a REVIEWER is shown a pair whose other side is not publicly visible — a suspected match
   * must never disclose somebody else's pending title and id, and owning one side of a pair does
   * not entitle anybody to the other side. That is the whole of the leak this filter closes: a
   * pending submission that resembles a public entry records a pair with it, and the public
   * entry's owner is not the pending entry's owner.
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
      .filter(({ other: match }) => scope.reviewer || isPubliclyVisible(match))
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
   * The OWNED entry is the one whose side is filtered on; the OTHER side is what gets reported —
   * and reporting it is disclosure of an entry this caller does not own. So the other side is held
   * to the same bar as everywhere else: publicly visible, unless the caller is a reviewer.
   *
   * WITHOUT THAT FILTER THIS ROUTE IS A WINDOW INTO THE REVIEW QUEUE. Detection runs a pending
   * submission against the PUBLIC corpus, so a pair between somebody's pending entry and an
   * unrelated publisher's live one is the ordinary case, not the exotic one — and the live entry's
   * owner reaching `/v1/me/duplicates` would read back the pending entry's id and title.
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

    const reviewer = isReviewer(principal);
    return rows
      .filter(({ other: match }) => reviewer || isPubliclyVisible(match))
      .map(({ pair, other: match }) => ({
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

/**
 * T3+, on a session.
 *
 * The editorial role is session-only, here as everywhere else: a leaked key must not read the full
 * patch of every entry in the corpus, or the non-public side of every duplicate pair, just because
 * its owner is a reviewer.
 */
export function isReviewer(principal: Principal | null): boolean {
  if (!principal) return false;
  return (
    principal.credentialKind === "session" &&
    (principal.role === "reviewer" || principal.role === "admin")
  );
}

/** The public read invariant, applied to one already-loaded row. */
function isPubliclyVisible(row: OpportunityRow): boolean {
  return row.reviewStatus === "approved" && row.isListed;
}

/** Owner — by submission or by namespace — or a reviewer. The one definition of "privileged". */
export function isPrivileged(row: OpportunityRow, principal: Principal | null): boolean {
  if (!principal) return false;
  if (isReviewer(principal)) return true;
  if (row.submittedBy === principal.accountId) return true;
  return (
    row.sourcePublisher !== null &&
    principal.memberships.some((m) => m.slug === row.sourcePublisher)
  );
}
