/**
 * The one ownership rule for account-scoped opportunity surfaces and duplicate notifications.
 *
 * An account owns a listing when it submitted it directly OR holds a membership on the
 * organization whose slug is stored as `sourcePublisher`. Reviewer privilege is deliberately not
 * part of this rule: it grants editorial visibility, never ownership or notification delivery.
 */
import { type SQL, eq, inArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import { type OpportunityRow, orgMemberships, organizations } from "../../../db/schema.js";
import type { Principal } from "../../shared/capabilities.js";

interface OwnershipColumns {
  submittedBy: AnyPgColumn;
  sourcePublisher: AnyPgColumn;
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

/** In-memory form of the exact same rule, for already-loaded rows. */
export function isOpportunityOwnedBy(row: OpportunityRow, principal: Principal): boolean {
  if (row.submittedBy === principal.accountId) return true;
  return (
    row.sourcePublisher !== null &&
    principal.memberships.some((membership) => membership.slug === row.sourcePublisher)
  );
}

/**
 * Every account that owns this row, deduplicated across direct submission and organization
 * membership. This is the recipient resolver; it never includes reviewers merely for reviewing.
 */
export async function opportunityOwnerAccountIds(
  db: DbLike,
  row: OpportunityRow,
): Promise<number[]> {
  const accountIds = new Set<number>();
  if (row.submittedBy !== null) accountIds.add(row.submittedBy);

  if (row.sourcePublisher !== null) {
    const members = await db
      .select({ accountId: orgMemberships.accountId })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(organizations.slug, row.sourcePublisher));
    for (const member of members) accountIds.add(member.accountId);
  }

  return [...accountIds];
}
