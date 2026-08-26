/** Membership invites: privileged creation, revocation, and verified-email redemption. */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { accounts, auditLog, orgMembershipInvites, orgMemberships } from "../../src/db/schema.js";
import { bearer, seedIdentity, seedOrganization, signIn, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const SLUG = "m3invite-org";
const EMAILS = {
  reviewer: "m3invite-reviewer@rfphub.invalid",
  accepted: "m3invite-accepted@rfphub.invalid",
  changedRole: "m3invite-changed-role@rfphub.invalid",
  equalRole: "m3invite-equal-role@rfphub.invalid",
  failed: "m3invite-failed@rfphub.invalid",
  revoked: "m3invite-revoked@rfphub.invalid",
};

describeWithDb("organisation membership invites", () => {
  let app: FastifyInstance;
  let reviewerToken: string;
  let organizationId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3invite-reviewer",
      role: "reviewer",
    });
    const organization = await seedOrganization({ slug: SLUG, name: "Invite Test Org" });
    reviewerToken = reviewer.token;
    organizationId = organization.id;
    userIds.push(reviewer.userId);
  });

  afterAll(async () => {
    await cleanupFixtures({
      organizationSlugs: [SLUG],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  it("creates one case-insensitive pending invite and redeems it on verified sign-in", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
      payload: { email: "M3Invite-Accepted@RFPHub.Invalid", role: "owner" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      organizationSlug: SLUG,
      email: EMAILS.accepted,
      role: "owner",
      acceptedAt: null,
      acceptedAccountId: null,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
      payload: { email: EMAILS.accepted },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("membership_invite_exists");

    const pending = await app.inject({
      method: "GET",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().items).toEqual([
      expect.objectContaining({ id: created.json().id, email: EMAILS.accepted, role: "owner" }),
    ]);

    const identity = await signIn(EMAILS.accepted);
    userIds.push(identity.userId);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(identity.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships).toContainEqual(
      expect.objectContaining({ slug: SLUG, role: "owner" }),
    );

    const acceptedAccount = (
      await db.select().from(accounts).where(eq(accounts.authUserId, identity.userId)).limit(1)
    )[0];
    expect(acceptedAccount).toBeTruthy();
    const acceptedInvite = (
      await db
        .select()
        .from(orgMembershipInvites)
        .where(eq(orgMembershipInvites.id, created.json().id))
        .limit(1)
    )[0];
    expect(acceptedInvite?.acceptedAt).toBeInstanceOf(Date);
    expect(acceptedInvite?.acceptedAccountId).toBe(acceptedAccount?.id);

    const memberships = await db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.organizationId, organizationId),
          eq(orgMemberships.accountId, acceptedAccount?.id ?? -1),
        ),
      );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");

    const audit = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "organization"), eq(auditLog.subjectId, organizationId)));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["invite_member", "accept_member_invite"]),
    );

    const noLongerPending = await app.inject({
      method: "GET",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
    });
    expect(noLongerPending.json().items).toEqual([]);
  });

  it.each([
    {
      branch: "replaces a different existing membership role",
      email: EMAILS.changedRole,
      handle: "m3invite-changed-role",
      before: "publisher" as const,
      invited: "owner" as const,
    },
    {
      branch: "keeps an equal existing membership role as a no-op",
      email: EMAILS.equalRole,
      handle: "m3invite-equal-role",
      before: "admin" as const,
      invited: "admin" as const,
    },
  ])("$branch and audits the settled role", async ({ email, handle, before, invited }) => {
    const identity = await seedIdentity(email, { handle });
    userIds.push(identity.userId);
    await db.insert(orgMemberships).values({
      accountId: identity.account.id,
      organizationId,
      role: before,
    });
    const created = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
      payload: { email, role: invited },
    });
    expect(created.statusCode, created.body).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(identity.token),
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().memberships).toContainEqual(
      expect.objectContaining({ slug: SLUG, role: invited }),
    );

    const storedMembership = await db
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.organizationId, organizationId),
          eq(orgMemberships.accountId, identity.account.id),
        ),
      );
    expect(storedMembership).toEqual([{ role: invited }]);

    const acceptedInvite = (
      await db
        .select()
        .from(orgMembershipInvites)
        .where(eq(orgMembershipInvites.id, created.json().id))
        .limit(1)
    )[0];
    expect(acceptedInvite).toMatchObject({
      acceptedAt: expect.any(Date),
      acceptedAccountId: identity.account.id,
    });

    const acceptanceAudit = await db
      .select({ patch: auditLog.patch })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "organization"),
          eq(auditLog.subjectId, organizationId),
          eq(auditLog.actorAccountId, identity.account.id),
          eq(auditLog.action, "accept_member_invite"),
        ),
      );
    expect(acceptanceAudit).toEqual([
      {
        patch: expect.objectContaining({
          inviteId: created.json().id,
          accountId: identity.account.id,
          role: { before, after: invited },
        }),
      },
    ]);
  });

  it("keeps the session live and invite pending without logging its email when redemption throws", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
      payload: { email: EMAILS.failed, role: "publisher" },
    });
    expect(created.statusCode).toBe(200);

    const identity = await signIn(EMAILS.failed);
    userIds.push(identity.userId);
    const accountsService = app.auth.principals.accounts as unknown as {
      redeemMembershipInvites(...args: unknown[]): Promise<void>;
    };
    const failure = new Error(`simulated invite redemption failure for ${EMAILS.failed}`, {
      cause: { code: "40001", detail: `query parameter: ${EMAILS.failed}` },
    });
    const redemption = vi
      .spyOn(accountsService, "redeemMembershipInvites")
      .mockRejectedValueOnce(failure);
    const logged = vi.spyOn(app.log, "error");

    try {
      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: bearer(identity.token),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().memberships).not.toContainEqual(expect.objectContaining({ slug: SLUG }));

      const account = (
        await db.select().from(accounts).where(eq(accounts.authUserId, identity.userId)).limit(1)
      )[0];
      expect(account).toBeTruthy();
      expect(logged).toHaveBeenCalledWith(
        {
          errorCategory: "database",
          errorCode: "40001",
          operation: "redeem_membership_invites",
          accountId: account?.id,
        },
        "membership invite redemption failed; principal resolution will continue",
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain(EMAILS.failed);

      const invite = (
        await db
          .select()
          .from(orgMembershipInvites)
          .where(eq(orgMembershipInvites.id, created.json().id))
          .limit(1)
      )[0];
      expect(invite).toMatchObject({ acceptedAt: null, acceptedAccountId: null });
      expect(
        await db
          .select()
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.organizationId, organizationId),
              eq(orgMemberships.accountId, account?.id ?? -1),
            ),
          ),
      ).toEqual([]);
    } finally {
      redemption.mockRestore();
      logged.mockRestore();
    }
  });

  it("revokes an invite before sign-in so no membership can materialize", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${SLUG}/invites`,
      headers: bearer(reviewerToken),
      payload: { email: EMAILS.revoked },
    });
    expect(created.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/review/organizations/${SLUG}/invites/${created.json().id}`,
      headers: bearer(reviewerToken),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: created.json().id, email: EMAILS.revoked });
    expect(
      await db
        .select()
        .from(orgMembershipInvites)
        .where(eq(orgMembershipInvites.id, created.json().id)),
    ).toEqual([]);

    const identity = await signIn(EMAILS.revoked);
    userIds.push(identity.userId);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(identity.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships).not.toContainEqual(expect.objectContaining({ slug: SLUG }));

    const audit = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "organization"), eq(auditLog.subjectId, organizationId)));
    expect(audit.map((row) => row.action)).toContain("revoke_member_invite");
  });
});
