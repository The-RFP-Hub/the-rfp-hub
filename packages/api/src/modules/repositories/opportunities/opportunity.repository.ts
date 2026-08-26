import { type SQL, eq, inArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbLike } from "../../../db/client.js";
import type { Principal } from "../../shared/capabilities.js";

export interface OwnershipColumns {
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

/**
 * The first repository seam. Domain query methods arrive here as services are migrated; until then
 * it has no query surface and keeps its executor private from service callers.
 */
export class OpportunityRepository {
  constructor(private readonly exec: DbLike) {}

  /** Keeps the executor owned by the repository without exposing it to service callers. */
  protected executor(): DbLike {
    return this.exec;
  }
}
