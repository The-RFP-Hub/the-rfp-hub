/**
 * The one ownership rule for account-scoped opportunity surfaces and duplicate notifications.
 *
 * An account owns a listing when it submitted it directly OR holds a membership on the
 * organization whose slug is stored as `sourcePublisher`. Reviewer privilege is deliberately not
 * part of this rule: it grants editorial visibility, never ownership or notification delivery.
 */
import type { OpportunityRow } from "../../../db/schema.js";
export { ownedOpportunityPredicate } from "../../repositories/index.js";
import type { Principal } from "../../shared/capabilities.js";

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
export function mergeOpportunityOwnerAccountIds(
  row: OpportunityRow,
  memberAccountIds: readonly number[],
): number[] {
  const accountIds = new Set<number>();
  if (row.submittedBy !== null) accountIds.add(row.submittedBy);
  for (const accountId of memberAccountIds) accountIds.add(accountId);
  return [...accountIds];
}
