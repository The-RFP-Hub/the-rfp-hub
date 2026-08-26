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
import type { DbLike } from "../../../db/client.js";
import {
  type OrgMembershipRow,
  accounts,
  orgMemberships,
  organizations,
} from "../../../db/schema.js";
import type { Membership } from "../../shared/capabilities.js";

export interface PublishAuthority {
  /** Whether the account still holds a membership on the namespace's organisation, at all. */
  member: boolean;
  /** Whether that membership is on a VERIFIED organisation — the T2 answer, as of this moment. */
  verified: boolean;
  /** The admin-granted publish-anywhere flag, as of this moment. */
  directCreate: boolean;
}

export class MembershipRepository {
  constructor(private readonly exec: DbLike) {}

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
  async hasAnyVerifiedMembership(accountId: number): Promise<boolean> {
    const rows = await this.exec
      .select({ id: orgMemberships.id })
      .from(organizations)
      .innerJoin(orgMemberships, eq(orgMemberships.organizationId, organizations.id))
      .where(and(eq(orgMemberships.accountId, accountId), eq(organizations.verified, true)))
      .limit(1);
    return rows.length > 0;
  }

  async resolvePublishAuthority(accountId: number, namespace: string): Promise<PublishAuthority> {
    // The organisation leads the join so its row is locked before the membership's, which is the
    // order the claim service uses too. Within one statement the difference is a few microseconds,
    // but "the same order everywhere" is only true if it is true here as well.
    const membership = await this.exec
      .select({ verified: organizations.verified })
      .from(organizations)
      .innerJoin(orgMemberships, eq(orgMemberships.organizationId, organizations.id))
      .where(and(eq(orgMemberships.accountId, accountId), eq(organizations.slug, namespace)))
      .for("share", { of: [organizations, orgMemberships] })
      .limit(1);

    const account = await this.exec
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
  }

  async accountIdsForOrgSlug(slug: string): Promise<number[]> {
    const members = await this.exec
      .select({ accountId: orgMemberships.accountId })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(organizations.slug, slug));
    return members.map((member) => member.accountId);
  }

  async lockForAccountAndOrganization(
    accountId: number,
    organizationId: number,
  ): Promise<Pick<OrgMembershipRow, "id" | "role"> | undefined> {
    const rows = await this.exec
      .select({ id: orgMemberships.id, role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.accountId, accountId),
          eq(orgMemberships.organizationId, organizationId),
        ),
      )
      .for("update")
      .limit(1);
    return rows[0];
  }

  async updateRole(
    id: number,
    role: OrgMembershipRow["role"],
  ): Promise<OrgMembershipRow["role"] | null> {
    const settled = await this.exec
      .update(orgMemberships)
      .set({ role })
      .where(eq(orgMemberships.id, id))
      .returning({ role: orgMemberships.role });
    return settled[0]?.role ?? null;
  }

  async upsertRole(
    accountId: number,
    organizationId: number,
    role: OrgMembershipRow["role"],
  ): Promise<OrgMembershipRow["role"] | null> {
    const settled = await this.exec
      .insert(orgMemberships)
      .values({ accountId, organizationId, role })
      .onConflictDoUpdate({
        target: [orgMemberships.accountId, orgMemberships.organizationId],
        set: { role },
      })
      .returning({ role: orgMemberships.role });
    return settled[0]?.role ?? null;
  }

  /**
   * The organizations this account publishes for, with each one's verified state.
   *
   * Both halves are needed together: the membership says which namespace, the verified flag says
   * whether a write into it auto-approves. Reading them separately is how the two answers drift.
   */
  async forAccount(accountId: number): Promise<Membership[]> {
    return this.exec
      .select({ slug: organizations.slug, verified: organizations.verified })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(orgMemberships.accountId, accountId));
  }

  /**
   * The same memberships, with the organization's name and the account's role in it — what `/v1/me`
   * shows a human. The authorization path deliberately does NOT use this: it needs the slug and the
   * verified flag and nothing else, and a wider read on a hot path is a wider read.
   */
  async detailedForAccount(accountId: number) {
    return this.exec
      .select({
        slug: organizations.slug,
        name: organizations.name,
        verified: organizations.verified,
        role: orgMemberships.role,
      })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(orgMemberships.accountId, accountId))
      .orderBy(organizations.slug);
  }
}
