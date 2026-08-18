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
import { type DB, db as defaultDb } from "../../../db/client.js";
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
import { badRequest, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";
import { isUniqueViolation } from "../auth/account.service.js";

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
      const row = await findOrganization(tx, slug);
      if (row.verified === verified) return this.summarize(row);
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
      return this.summarize(next);
    });
  }

  /** Directory metadata. Never the verified flag — that has its own audited verb. */
  async updateOrganization(
    actorAccountId: number,
    slug: string,
    metadata: OrganizationMetadata,
  ): Promise<OrganizationSummaryView> {
    return this.db.transaction(async (tx) => {
      const row = await findOrganization(tx, slug);
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

      if (Object.keys(patch).length === 0) return this.summarize(row);

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
      return this.summarize(next);
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
    return Promise.all(rows.map((row) => this.summarize(row)));
  }

  private async summarize(row: OrganizationRow): Promise<OrganizationSummaryView> {
    const counted = await this.db
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

async function findOrganization(tx: TxLike, slug: string): Promise<OrganizationRow> {
  const rows = await tx.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no organisation \`${slug}\`.`);
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
