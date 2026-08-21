/**
 * "May this account publish into this namespace" — asked INSIDE the transaction that writes, not at
 * authentication time.
 *
 * A principal's memberships are resolved once, when the bearer is exchanged for a `Principal`
 * (`principal.service.ts`), and a request can outlive that answer: a reviewer revoking a membership
 * or un-verifying an organisation while a write is in flight would otherwise be beaten by the write,
 * which decided it could auto-publish before the revocation existed. The claim service already
 * re-proves ownership under a row lock for exactly this reason; this is the write path's half of the
 * same rule.
 *
 * FOR SHARE ON EVERY ROW THE ANSWER IS DERIVED FROM — the membership, the organisation whose
 * `verified` flag makes it a publishing membership, and the account whose `direct_create` grant
 * publishes anywhere. Locking only one of the three would leave the same race open through the
 * other two: an `UPDATE organizations SET verified = false` or an `UPDATE accounts SET
 * direct_create = false` committing while the write is in flight would still be beaten by it. The
 * share lock is what makes the paths conflict — a revocation that arrives after this read waits
 * until the write commits, and one that committed before it is seen by the statement's own snapshot
 * (READ COMMITTED). Share rather than update because concurrent writers are not in conflict with
 * each other, only with whoever is taking the authority away.
 *
 * LOCK ORDER, REPO-WIDE: **entry → organisation → membership → account** — with one stated
 * exception. A path that needs the account row EXCLUSIVELY takes it before this read rather than
 * after (the write path's create branch does, for its pending-submission ceiling), because holding
 * the shared lock this function takes and then upgrading it is a deadlock between two such paths.
 * The rule that actually matters is therefore: never hold a weaker lock on a row you will later
 * need a stronger one on. The caller holds
 * `FOR UPDATE` on the opportunity row before calling this, and the claim service takes the same
 * order in both `grant()` and `decide()` (which is why a decision reads the entry it is about
 * before it locks the claim). API-key creation takes the account row alone, at the end of that
 * order. There is therefore no cycle — only a brief wait between a write and a key mint on the same
 * account. A path that needs two of these must acquire them in this order.
 *
 * The answer is DATA, not a decision: `effectiveCaps` in `modules/shared/capabilities.ts` stays the
 * single pure place where capabilities are derived, and this only replaces the facts underneath it.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../../db/client.js";
import { accounts, orgMemberships, organizations } from "../../../db/schema.js";

export interface PublishAuthority {
  /** Whether the account still holds a membership on the namespace's organisation, at all. */
  member: boolean;
  /** Whether that membership is on a VERIFIED organisation — the T2 answer, as of this moment. */
  verified: boolean;
  /** The admin-granted publish-anywhere flag, as of this moment. */
  directCreate: boolean;
}

/** Injectable so a test can drive the decision without a database. */
export type PublishAuthorityResolver = (
  tx: Tx,
  accountId: number,
  namespace: string,
) => Promise<PublishAuthority>;

/**
 * Whether this account publishes for ANY verified organisation — a different question from
 * `resolvePublishAuthority`, which asks about ONE namespace.
 *
 * It exists for the exemptions: a person the Hub has already vouched for somewhere is not the
 * account a spam ceiling is aimed at, and their out-of-namespace proposals should not be metered
 * because of where else they publish. Read inside the caller's transaction, unlocked: this widens
 * rather than narrows, so the dangerous direction is a membership appearing mid-flight (it cannot —
 * granting one is a reviewer action on another connection) rather than one disappearing.
 */
export async function hasAnyVerifiedMembership(tx: Tx, accountId: number): Promise<boolean> {
  const rows = await tx
    .select({ id: orgMemberships.id })
    .from(organizations)
    .innerJoin(orgMemberships, eq(orgMemberships.organizationId, organizations.id))
    .where(and(eq(orgMemberships.accountId, accountId), eq(organizations.verified, true)))
    .limit(1);
  return rows.length > 0;
}

export const resolvePublishAuthority: PublishAuthorityResolver = async (
  tx,
  accountId,
  namespace,
) => {
  // The organisation leads the join so its row is locked before the membership's, which is the
  // order the claim service uses too. Within one statement the difference is a few microseconds,
  // but "the same order everywhere" is only true if it is true here as well.
  const membership = await tx
    .select({ verified: organizations.verified })
    .from(organizations)
    .innerJoin(orgMemberships, eq(orgMemberships.organizationId, organizations.id))
    .where(and(eq(orgMemberships.accountId, accountId), eq(organizations.slug, namespace)))
    .for("share", { of: [organizations, orgMemberships] })
    .limit(1);

  const account = await tx
    .select({ directCreate: accounts.directCreate })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("share")
    .limit(1);

  // Every field FAILS CLOSED on an absent row: a membership that has just been revoked, or an
  // account row that cannot be read, yields no authority rather than the authority it used to have.
  return {
    member: membership.length > 0,
    verified: membership[0]?.verified === true,
    directCreate: account[0]?.directCreate === true,
  };
};
