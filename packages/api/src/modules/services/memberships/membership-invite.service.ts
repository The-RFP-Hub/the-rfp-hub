/** Reviewer-created organisation memberships that wait for ownership of an email to be proved. */
import { and, eq, isNull } from "drizzle-orm";
import { type DB, type DbLike, db as defaultDb } from "../../../db/client.js";
import {
  type OrgMembershipInviteRow,
  orgMembershipInvites,
  organizations,
} from "../../../db/schema.js";
import type { MembershipInviteView } from "../../shared/api-views.js";
import { badRequest, conflict, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";
import { isUniqueViolation, violatedConstraint } from "../auth/account.service.js";

export type InviteRole = "owner" | "admin" | "publisher";

const INVITE_ROLES: InviteRole[] = ["owner", "admin", "publisher"];
const EMAIL_MAX = 320;
const PENDING_UNIQUE = "ux_org_membership_invite_pending";

export class MembershipInviteService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  async create(
    invitedBy: number,
    slug: string,
    rawEmail: string,
    rawRole?: string,
  ): Promise<MembershipInviteView> {
    const email = normalizeInviteEmail(rawEmail);
    const role = normalizeInviteRole(rawRole);
    try {
      return await this.db.transaction(async (tx) => {
        const org = await findOrganization(tx, slug);
        const rows = await tx
          .insert(orgMembershipInvites)
          .values({ organizationId: org.id, email, role, invitedBy })
          .returning();
        const invite = rows[0];
        if (!invite) throw new Error("membership invite vanished during creation");
        await this.audit.record(tx, {
          subjectKind: "organization",
          subjectId: org.id,
          actorKind: "user",
          actorAccountId: invitedBy,
          action: "invite_member",
          patch: { inviteId: invite.id, email, role },
        });
        return toView(invite, org.slug);
      });
    } catch (error) {
      if (isUniqueViolation(error) && violatedConstraint(error) === PENDING_UNIQUE) {
        throw conflict(
          "membership_invite_exists",
          `a pending membership invite for ${email} already exists on ${slug}.`,
        );
      }
      throw error;
    }
  }

  async listPending(slug: string): Promise<MembershipInviteView[]> {
    const org = await findOrganization(this.db, slug);
    const rows = await this.db
      .select()
      .from(orgMembershipInvites)
      .where(
        and(
          eq(orgMembershipInvites.organizationId, org.id),
          isNull(orgMembershipInvites.acceptedAt),
        ),
      )
      .orderBy(orgMembershipInvites.createdAt, orgMembershipInvites.id);
    return rows.map((row) => toView(row, org.slug));
  }

  async revoke(invitedBy: number, slug: string, inviteId: number): Promise<MembershipInviteView> {
    return this.db.transaction(async (tx) => {
      const org = await findOrganization(tx, slug);
      const rows = await tx
        .delete(orgMembershipInvites)
        .where(
          and(
            eq(orgMembershipInvites.id, inviteId),
            eq(orgMembershipInvites.organizationId, org.id),
            isNull(orgMembershipInvites.acceptedAt),
          ),
        )
        .returning();
      const invite = rows[0];
      if (!invite) throw notFound(`no pending membership invite ${inviteId} on ${slug}.`);
      await this.audit.record(tx, {
        subjectKind: "organization",
        subjectId: org.id,
        actorKind: "user",
        actorAccountId: invitedBy,
        action: "revoke_member_invite",
        patch: { inviteId: invite.id, email: invite.email, role: invite.role },
      });
      return toView(invite, org.slug);
    });
  }
}

type InviteDb = Pick<DbLike, "select">;

async function findOrganization(db: InviteDb, slug: string) {
  const rows = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  const org = rows[0];
  if (!org) throw notFound(`no organization ${JSON.stringify(slug)}.`);
  return org;
}

function normalizeInviteRole(raw: string | undefined): InviteRole {
  const role = (raw ?? "publisher").trim().toLowerCase();
  if (!(INVITE_ROLES as string[]).includes(role)) {
    throw badRequest("invalid_role", `\`role\` must be one of ${INVITE_ROLES.join(", ")}.`);
  }
  return role as InviteRole;
}

export function normalizeInviteEmail(raw: string): string {
  const email = (raw ?? "").trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest("invalid_email", "`email` must be a valid email address.");
  }
  return email;
}

function toView(invite: OrgMembershipInviteRow, organizationSlug: string): MembershipInviteView {
  return {
    id: invite.id,
    organizationSlug,
    email: invite.email,
    role: invite.role,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    acceptedAccountId: invite.acceptedAccountId,
  };
}
