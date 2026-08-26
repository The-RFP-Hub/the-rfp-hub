import { and, eq, isNull } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { type OrgMembershipInviteRow, orgMembershipInvites } from "../../../db/schema.js";

export interface CreateMembershipInviteInput {
  organizationId: number;
  email: string;
  role: "owner" | "admin" | "publisher";
  invitedBy: number;
}

export class MembershipInviteRepository {
  constructor(private readonly exec: DbLike) {}

  async create(input: CreateMembershipInviteInput): Promise<OrgMembershipInviteRow | undefined> {
    const rows = await this.exec.insert(orgMembershipInvites).values(input).returning();
    return rows[0];
  }

  async listPending(organizationId: number): Promise<OrgMembershipInviteRow[]> {
    return this.exec
      .select()
      .from(orgMembershipInvites)
      .where(
        and(
          eq(orgMembershipInvites.organizationId, organizationId),
          isNull(orgMembershipInvites.acceptedAt),
        ),
      )
      .orderBy(orgMembershipInvites.createdAt, orgMembershipInvites.id);
  }

  async revokePending(
    organizationId: number,
    inviteId: number,
  ): Promise<OrgMembershipInviteRow | undefined> {
    const rows = await this.exec
      .delete(orgMembershipInvites)
      .where(
        and(
          eq(orgMembershipInvites.id, inviteId),
          eq(orgMembershipInvites.organizationId, organizationId),
          isNull(orgMembershipInvites.acceptedAt),
        ),
      )
      .returning();
    return rows[0];
  }
}
