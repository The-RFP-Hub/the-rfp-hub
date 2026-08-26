/**
 * The T3 surface: approving and rejecting entries, verifying organisations, and granting the
 * memberships that make a namespace auto-approve.
 *
 * Two things here are load-bearing beyond the obvious:
 *
 * **Organisation metadata is edited HERE and on the org-owner route — never on the write path.**
 * The read path's `upsertOrganization` rewrites name, website, logo, banner, social links,
 * ecosystems and contacts on conflict; letting a submission reach it would let any T1 overwrite a
 * verified organisation's branding by naming its slug. So a submission creates directory stubs and
 * nothing else, and every metadata change arrives through an authorised, audited route.
 *
 * **Verifying an organisation is the single act that flips every one of its members to T2**, in
 * every namespace-scoped decision, immediately. Unverifying takes it back the same way. Both are
 * audited on the ORGANISATION, which is the subject whose state changed — the members' accounts did
 * not.
 */
import { and, count, eq, ilike, or } from "drizzle-orm";
import { type DB, type DbLike, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityRow,
  type OrganizationRow,
  accounts,
  opportunities,
  orgMemberships,
  organizations,
} from "../../../db/schema.js";
import type {
  MembershipResultView,
  OrganizationSummaryView,
  ReviewDecisionView,
} from "../../shared/api-views.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import { AuditService, OPERATING_ORG_CAPACITY } from "../audit/audit.service.js";
import { isUniqueViolation } from "../auth/account.service.js";
import { resolvePublishAuthority } from "../auth/publish-authority.js";

export type OrgRole = "owner" | "admin" | "publisher";

const ORG_ROLES: OrgRole[] = ["owner", "admin", "publisher"];

/** The directory fields an authorised editor may change. Deliberately not the verified flag. */
export interface OrganizationMetadata {
  name?: string;
  description?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  ecosystems?: string[];
}

export class ReviewService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  // ── opportunities ──────────────────────────────────────────────────────────────
  /**
   * Approve or reject one entry.
   *
   * Rejection also UNLISTS: a rejected-but-listed row would be excluded from the public reads by
   * the review status alone, but leaving `is_listed` true records a listing intent that is no
   * longer true, and the two flags disagreeing is how a later query gets it wrong.
   */
  async decide(
    reviewerId: number,
    publicId: string,
    approve: boolean,
    reason?: string | null,
  ): Promise<ReviewDecisionView> {
    return this.db.transaction(async (tx) => {
      const row = await lockOpportunity(tx, publicId);
      assertNotMerged(row);
      const now = new Date();
      const target = approve ? "approved" : "rejected";
      if (row.reviewStatus === target) {
        return { id: row.publicId, reviewStatus: row.reviewStatus, isListed: row.isListed };
      }
      const updated = await tx
        .update(opportunities)
        .set({
          reviewStatus: target,
          isListed: approve ? row.isListed : false,
          approvedBy: approve ? reviewerId : row.approvedBy,
          approvedAt: approve ? (row.approvedAt ?? now) : row.approvedAt,
          lastSeenAt: approve ? now : row.lastSeenAt,
          updatedAt: now,
        })
        .where(eq(opportunities.id, row.id))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: approve ? "approve" : "reject",
        patch: {
          reviewStatus: { before: row.reviewStatus, after: target },
          ...(approve ? {} : { isListed: { before: row.isListed, after: false } }),
          ...(reason ? { reason } : {}),
        },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  /** Unlist or relist. Separate from approval: a listing decision is not a conformance decision. */
  async setListed(
    reviewerId: number,
    publicId: string,
    isListed: boolean,
  ): Promise<ReviewDecisionView> {
    return this.db.transaction(async (tx) => {
      const row = await lockOpportunity(tx, publicId);
      assertNotMerged(row);
      if (row.isListed === isListed) {
        return { id: row.publicId, reviewStatus: row.reviewStatus, isListed: row.isListed };
      }
      const updated = await tx
        .update(opportunities)
        .set({ isListed, updatedAt: new Date() })
        .where(eq(opportunities.id, row.id))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: isListed ? "relist" : "unlist",
        patch: { isListed: { before: row.isListed, after: isListed } },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  // ── organisations ──────────────────────────────────────────────────────────────
  async setVerified(
    reviewerId: number,
    slug: string,
    verified: boolean,
  ): Promise<OrganizationSummaryView> {
    return this.db.transaction(async (tx) => {
      // The no-op check is part of the write. Lock first so two identical concurrent decisions do
      // not both read the old flag, both UPDATE it, and append two audit rows for one transition.
      const row = await lockOrganization(tx, slug);
      if (row.verified === verified) return this.summarize(tx, row);
      const now = new Date();
      const updated = await tx
        .update(organizations)
        .set({ verified, verifiedAt: verified ? now : null, updatedAt: now })
        .where(eq(organizations.id, row.id))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "organization",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: reviewerId,
        action: verified ? "verify_organization" : "unverify_organization",
        patch: { verified: { before: row.verified, after: verified } },
      });
      return this.summarize(tx, next);
    });
  }

  /** Directory metadata. Never the verified flag — that has its own audited verb. */
  async updateOrganization(
    actorAccountId: number,
    slug: string,
    metadata: OrganizationMetadata,
    /** Owner/admin route only: re-prove the membership inside the transaction that writes. */
    requireManager = false,
  ): Promise<OrganizationSummaryView> {
    return this.db.transaction(async (tx) => {
      // The controller's check is only a cheap fail-fast. A membership can be revoked after that
      // read and before this UPDATE; locking the organisation first, then re-reading the membership
      // under a shared lock, makes revocation and the write serialize in the repository's standing
      // organisation → membership order. Whichever commits first is what the other observes.
      const row = await lockOrganization(tx, slug);
      if (requireManager) {
        const membership = await tx
          .select({ role: orgMemberships.role })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.accountId, actorAccountId),
              eq(orgMemberships.organizationId, row.id),
            ),
          )
          .for("share")
          .limit(1);
        const role = membership[0]?.role;
        if (role !== "owner" && role !== "admin") {
          throw forbidden(
            "not_an_org_manager",
            `editing \`${slug}\` requires an owner or admin membership on it.`,
          );
        }
      }
      const set: Partial<OrganizationRow> = { updatedAt: new Date() };
      const patch: Record<string, unknown> = {};

      if (metadata.name !== undefined) {
        const name = metadata.name.trim();
        if (name === "") throw badRequest("invalid_name", "`name` may not be empty.");
        if (name !== row.name) {
          set.name = name;
          patch.name = { before: row.name, after: name };
        }
      }
      if (metadata.description !== undefined && metadata.description !== row.description) {
        set.description = metadata.description;
        patch.description = { before: row.description, after: metadata.description };
      }
      if (metadata.website !== undefined && metadata.website !== row.website) {
        set.website = metadata.website;
        patch.website = { before: row.website, after: metadata.website };
      }
      if (metadata.logoUrl !== undefined && metadata.logoUrl !== row.logoUrl) {
        set.logoUrl = metadata.logoUrl;
        patch.logoUrl = { before: row.logoUrl, after: metadata.logoUrl };
      }
      if (metadata.bannerUrl !== undefined && metadata.bannerUrl !== row.bannerUrl) {
        set.bannerUrl = metadata.bannerUrl;
        patch.bannerUrl = { before: row.bannerUrl, after: metadata.bannerUrl };
      }
      if (metadata.ecosystems !== undefined) {
        set.ecosystems = metadata.ecosystems;
        patch.ecosystems = { before: row.ecosystems, after: metadata.ecosystems };
      }

      if (Object.keys(patch).length === 0) return this.summarize(tx, row);

      const updated = await tx
        .update(organizations)
        .set(set)
        .where(eq(organizations.id, row.id))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "organization",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: actorAccountId,
        action: "update_organization",
        patch,
      });
      return this.summarize(tx, next);
    });
  }

  // ── memberships ────────────────────────────────────────────────────────────────
  async grantMembership(
    actorAccountId: number,
    slug: string,
    accountId: number,
    role: string | undefined,
    /** Internal: caps the one-time retry below at one, so a genuine bug cannot recurse forever. */
    retried = false,
  ): Promise<MembershipResultView> {
    const orgRole = normalizeOrgRole(role);
    try {
      return await this.db.transaction(async (tx) => {
        const org = await findOrganization(tx, slug);
        const account = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (!account[0]) throw notFound(`no account ${accountId}.`);

        const existing = await tx
          .select()
          .from(orgMemberships)
          .where(
            and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.organizationId, org.id)),
          )
          // A concurrent revoke must finish before this grant decides whether to UPDATE or INSERT.
          // Without the lock, DELETE can remove the row after this read; the UPDATE then affects
          // zero rows while the endpoint still audits and reports a membership that does not exist.
          .for("update")
          .limit(1);

        if (existing[0]) {
          if (existing[0].role === orgRole) {
            return { organizationSlug: org.slug, accountId, role: orgRole, member: true };
          }
          await tx
            .update(orgMemberships)
            .set({ role: orgRole })
            .where(eq(orgMemberships.id, existing[0].id));
        } else {
          await tx
            .insert(orgMemberships)
            .values({ accountId, organizationId: org.id, role: orgRole });
        }

        await this.audit.record(tx, {
          subjectKind: "organization",
          subjectId: org.id,
          actorKind: "user",
          actorAccountId: actorAccountId,
          action: "grant_publisher",
          patch: {
            accountId,
            role: { before: existing[0]?.role ?? null, after: orgRole },
          },
        });
        return { organizationSlug: org.slug, accountId, role: orgRole, member: true };
      });
    } catch (error) {
      // TWO REVIEWERS, ONE GRANT. The read above and the insert are not one atomic step, so two
      // concurrent grants of the same previously-absent membership can both see no row and both
      // reach the insert; the unique index (`ux_org_membership`) lets one in and raises 23505 at
      // the other. The grant is documented as idempotent, so the loser of that race has not
      // failed — retrying finds the row the winner just committed and takes the ordinary
      // "already a member" path above (updating the role if this call asked for a different one).
      if (retried || !isUniqueViolation(error)) throw error;
      return this.grantMembership(actorAccountId, slug, accountId, role, true);
    }
  }

  async revokeMembership(
    actorAccountId: number,
    slug: string,
    accountId: number,
  ): Promise<MembershipResultView> {
    return this.db.transaction(async (tx) => {
      const org = await findOrganization(tx, slug);
      const removed = await tx
        .delete(orgMemberships)
        .where(
          and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.organizationId, org.id)),
        )
        .returning();
      if (removed.length === 0) {
        return { organizationSlug: org.slug, accountId, role: null, member: false };
      }
      await this.audit.record(tx, {
        subjectKind: "organization",
        subjectId: org.id,
        actorKind: "user",
        actorAccountId: actorAccountId,
        action: "revoke_publisher",
        patch: { accountId, role: { before: removed[0]?.role ?? null, after: null } },
      });
      return { organizationSlug: org.slug, accountId, role: null, member: false };
    });
  }

  /** Whether this account may edit the organisation's directory entry as its owner/admin. */
  /**
   * A VERIFIED MEMBER PUBLISHES THEIR OWN ORGANISATION'S QUEUE.
   *
   * The same act a T2 write performs automatically, performed deliberately after the fact: an entry
   * filed under an organisation's namespace by somebody who could not auto-publish — a colleague
   * without a key's `publish` scope, a submission that arrived before the organisation was verified,
   * an edit that returned an approved entry to the queue — is the organisation's to release. Making
   * them wait for a Hub reviewer to rubber-stamp their own programme is a queue that exists only
   * because nobody wired this route.
   *
   * FOUR BOUNDARIES, and each one is a decision rather than an omission:
   *
   *   1. **VERIFIED membership, not any membership.** The list endpoint beside this one admits any
   *      member, because looking is not publishing. This one publishes to the world, so it rides the
   *      same trust event auto-publish does — the moment a reviewer verified the organisation.
   *   2. **Session only.** A leaked key must not be able to publish unreviewed content, which is the
   *      whole of the `canPublishImmediately` rule; approving is that same power in a second shape.
   *   3. **The NAMESPACE, not any operating organisation.** Widening this to "any org named in
   *      `operatingOrganizations`" was considered and rejected: an entry can name several operators,
   *      and approving publishes it in the NAMESPACE's name — so a co-operator could publish under
   *      somebody else's banner, which is the cross-org hazard the write path's containment rule
   *      exists to close. An entry filed under a namespace you do not publish for is answered 404,
   *      not 403, so this route cannot be used to enumerate other organisations' pending queues.
   *   4. **BOTH VERBS, and a REQUIRED REASON on the rejection.** Verified members decide — approve
   *      AND reject — within their own namespace; Hub reviewers decide anywhere. Rejection was
   *      withheld at first over the obvious conflict of interest (anyone may submit an entry ABOUT
   *      an organisation, and that organisation should not quietly suppress a third party's account
   *      of its own programme), but withholding it left spam in an organisation's namespace waiting
   *      on Hub staff. The counterweight is accountability rather than absence: a rejection here
   *      REQUIRES a written reason, the trail attributes it to the member by handle rather than
   *      coarsening it to "reviewer", and the submitter is shown that reason on their own listing.
   *      An organisation may still refuse things — it may no longer do it silently or anonymously.
   *
   * The membership is re-proved UNDER THE ENTRY'S LOCK, not trusted from the request's principal:
   * memberships are resolved when the bearer is exchanged, and a request can outlive that answer.
   * A reviewer un-verifying the organisation while this is in flight must not be beaten by it, so
   * the authority is read again inside the transaction, in the repo's standing lock order
   * (entry → organisation → membership). Fails closed: gone or unverified ⇒ refused.
   */
  async approveForNamespace(accountId: number, slug: string, publicId: string) {
    return this.decideForNamespace(accountId, slug, publicId, { approve: true });
  }

  /**
   * The same authority, the other verdict — and the reason is not optional.
   *
   * See `approveForNamespace` for the four boundaries; they are identical, and deliberately so:
   * the thing that makes a member trusted to publish is the thing that makes them trusted to
   * refuse, and a route pair whose guards drifted apart would be the interesting bug.
   */
  async rejectForNamespace(accountId: number, slug: string, publicId: string, reason: string) {
    const written = reason.trim();
    if (written === "") {
      throw badRequest(
        "reason_required",
        "rejecting an entry in your own namespace requires a reason. It is recorded against your account and shown to whoever submitted it — that accountability is what makes this decision yours to make.",
      );
    }
    return this.decideForNamespace(accountId, slug, publicId, { approve: false, reason: written });
  }

  private async decideForNamespace(
    accountId: number,
    slug: string,
    publicId: string,
    decision: { approve: boolean; reason?: string },
  ): Promise<ReviewDecisionView> {
    return this.db.transaction(async (tx) => {
      const row = await lockOpportunity(tx, publicId);
      // Not 403: an entry filed under a namespace this account does not publish for is, as far as
      // this route is concerned, not there at all.
      if (row.sourcePublisher !== slug) {
        throw notFound(`no opportunity ${JSON.stringify(publicId)} published under \`${slug}\`.`);
      }

      const authority = await resolvePublishAuthority(tx, accountId, slug);
      if (!authority.member || !authority.verified) {
        throw forbidden(
          "not_a_verified_member",
          `approving an entry published under \`${slug}\` requires a membership on it while it is a verified publisher.`,
        );
      }

      assertNotMerged(row);

      if (row.reviewStatus !== "pending") {
        throw conflict(
          "not_pending",
          `that entry is already ${row.reviewStatus}; only a pending entry can be decided here.`,
        );
      }

      const now = new Date();
      const target = decision.approve ? "approved" : "rejected";
      const updated = await tx
        .update(opportunities)
        .set({
          reviewStatus: target,
          // APPROVAL IS NOT A LISTING DECISION, and the staff route has always known that: it
          // preserves `is_listed` on approve and clears it on reject. Forcing it true here would
          // silently republish a row a reviewer had deliberately unlisted, or one that was rejected
          // (and therefore unlisted), edited, and requeued — an unlisting undone by somebody who
          // never saw it. Rejection still unlists, because leaving the flag true records a listing
          // intent that is no longer true and two flags that disagree are how a later query gets it
          // wrong.
          isListed: decision.approve ? row.isListed : false,
          approvedBy: decision.approve ? (row.approvedBy ?? accountId) : row.approvedBy,
          approvedAt: decision.approve ? (row.approvedAt ?? now) : row.approvedAt,
          // A publisher releasing their own entry is the same "still real" signal a write is; a
          // rejection says nothing about whether the programme exists.
          lastSeenAt: decision.approve ? now : row.lastSeenAt,
          updatedAt: now,
        })
        .where(eq(opportunities.id, row.id))
        .returning();
      const next = updated[0] ?? row;

      await this.audit.record(tx, {
        subjectKind: "opportunity",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: accountId,
        action: decision.approve ? "approve" : "reject",
        patch: {
          reviewStatus: { before: row.reviewStatus, after: target },
          ...(decision.approve || row.isListed === false
            ? {}
            : { isListed: { before: row.isListed, after: false } }),
          // `reason` is the human-facing half — the server's own words on an approval, the member's
          // written justification on a rejection — and `via` is the machine-readable one. The trail
          // has to distinguish a Hub reviewer's decision from a publisher's for BOTH verbs, and
          // `reason` alone cannot carry that once it is holding somebody's sentence.
          //
          // `via` is ALSO what keeps the by-handle promise for a member who happens to be staff:
          // the trail's public actor label coarsens a reviewer or admin to "reviewer", and a
          // dual-role member deciding in their PUBLISHER capacity would otherwise be anonymised by
          // a global role that had nothing to do with this decision. See `publicActor`.
          reason: decision.approve ? "operating_org_approval" : (decision.reason as string),
          via: OPERATING_ORG_CAPACITY,
        },
      });
      return { id: next.publicId, reviewStatus: next.reviewStatus, isListed: next.isListed };
    });
  }

  /** The organisation a slug names, or the same 404 every other organisation route answers with. */
  async requireOrganization(slug: string): Promise<OrganizationRow> {
    return findOrganization(this.db, slug);
  }

  async isOrgManager(accountId: number, slug: string): Promise<boolean> {
    const rows = await this.db
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(and(eq(orgMemberships.accountId, accountId), eq(organizations.slug, slug)))
      .limit(1);
    const role = rows[0]?.role;
    return role === "owner" || role === "admin";
  }

  // ── discovery ──────────────────────────────────────────────────────────────────
  async searchOrganizations(
    q: string | undefined,
    verified: boolean | undefined,
    limit = 25,
  ): Promise<OrganizationSummaryView[]> {
    const query = (q ?? "").trim();
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = and(
      query === ""
        ? undefined
        : or(ilike(organizations.slug, like), ilike(organizations.name, like)),
      verified === undefined ? undefined : eq(organizations.verified, verified),
    );
    const rows = await this.db
      .select()
      .from(organizations)
      .where(where)
      .orderBy(organizations.slug)
      .limit(limit);
    return Promise.all(rows.map((row) => this.summarize(this.db, row)));
  }

  private async summarize(exec: DbLike, row: OrganizationRow): Promise<OrganizationSummaryView> {
    const counted = await exec
      .select({ value: count() })
      .from(orgMemberships)
      .where(eq(orgMemberships.organizationId, row.id));
    return {
      slug: row.slug,
      name: row.name,
      verified: row.verified,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      website: row.website,
      ecosystems: row.ecosystems,
      memberCount: counted[0]?.value ?? 0,
    };
  }
}

type TxLike = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** The entry, locked, or a 404. Locked because every caller is about to change its state. */
async function lockOpportunity(tx: TxLike, publicId: string): Promise<OpportunityRow> {
  const rows = await tx
    .select()
    .from(opportunities)
    .where(eq(opportunities.publicId, publicId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
  return row;
}

/** A merge is terminal: no review or listing decision may make its loser live again. */
function assertNotMerged(row: OpportunityRow): void {
  if (row.mergedIntoId !== null) {
    throw conflict(
      "opportunity_merged",
      `opportunity ${JSON.stringify(row.publicId)} has been merged and cannot be changed.`,
    );
  }
}

/** The organisation row a metadata transaction is about to change, locked before membership. */
async function lockOrganization(tx: TxLike, slug: string): Promise<OrganizationRow> {
  const rows = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no organization \`${slug}\`.`);
  return row;
}

async function findOrganization(tx: TxLike | DB, slug: string): Promise<OrganizationRow> {
  const rows = await tx.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no organization \`${slug}\`.`);
  return row;
}

function normalizeOrgRole(raw: string | undefined): OrgRole {
  if (raw === undefined) return "publisher";
  const role = raw.trim().toLowerCase();
  if (!(ORG_ROLES as string[]).includes(role)) {
    throw badRequest("invalid_role", `\`role\` must be one of ${ORG_ROLES.join(", ")}.`);
  }
  return role as OrgRole;
}
