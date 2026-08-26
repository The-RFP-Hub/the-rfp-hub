/** Reviewer-created organisation memberships that wait for ownership of an email to be proved. */
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OrgMembershipInviteRow } from "../../../db/schema.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import type { MembershipInviteView } from "../../shared/api-views.js";
import { badRequest, conflict, notFound } from "../../shared/http-error.js";
import { isUniqueViolation, violatedConstraint } from "../auth/account.service.js";

export type InviteRole = "owner" | "admin" | "publisher";

const INVITE_ROLES: InviteRole[] = ["owner", "admin", "publisher"];
const EMAIL_MAX = 320;
const PENDING_UNIQUE = "ux_org_membership_invite_pending";

export class MembershipInviteService {
  private readonly repos: Repositories;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
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
      return await withTransaction(this.db, async (repos) => {
        const org = await findOrganization(repos, slug);
        const invite = await repos.membershipInvites.create({
          organizationId: org.id,
          email,
          role,
          invitedBy,
        });
        if (!invite) throw new Error("membership invite vanished during creation");
        await repos.audit.record({
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
    const org = await findOrganization(this.repos, slug);
    const rows = await this.repos.membershipInvites.listPending(org.id);
    return rows.map((row) => toView(row, org.slug));
  }

  async revoke(invitedBy: number, slug: string, inviteId: number): Promise<MembershipInviteView> {
    return withTransaction(this.db, async (repos) => {
      const org = await findOrganization(repos, slug);
      const invite = await repos.membershipInvites.revokePending(org.id, inviteId);
      if (!invite) throw notFound(`no pending membership invite ${inviteId} on ${slug}.`);
      await repos.audit.record({
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

async function findOrganization(repos: Repositories, slug: string) {
  const org = await repos.organizations.findBySlug(slug);
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
