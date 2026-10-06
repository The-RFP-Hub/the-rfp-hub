/** Owners and admins inviting colleagues to their own organization, without a Hub reviewer. */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { orgMembershipInvites, orgMemberships } from "../../src/db/schema.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  seedIdentity,
  seedOrganization,
  signIn,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const SLUG = "m3orginv-org";
const OTHER = "m3orginv-other";
const EMAILS = {
  owner: "m3orginv-owner@rfphub.invalid",
  admin: "m3orginv-admin@rfphub.invalid",
  publisher: "m3orginv-publisher@rfphub.invalid",
  stranger: "m3orginv-stranger@rfphub.invalid",
  otherOwner: "m3orginv-other-owner@rfphub.invalid",
  tempAdmin: "m3orginv-temp-admin@rfphub.invalid",
  tempOwner: "m3orginv-temp-owner@rfphub.invalid",
  altStillManager: "m3orginv-alt-still-manager@rfphub.invalid",
  altRemoved: "m3orginv-alt-removed@rfphub.invalid",
  altDemoted: "m3orginv-alt-demoted@rfphub.invalid",
};

describeWithDb("owner and admin membership invites", () => {
  let app: FastifyInstance;
  let orgId = 0;
  let ownerAccountId = 0;
  const tokens = {} as Record<keyof typeof EMAILS, string>;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const org = await seedOrganization({ slug: SLUG, name: "Invite Org" });
    orgId = org.id;
    const other = await seedOrganization({ slug: OTHER, name: "Other Org" });
    const roles = {
      owner: [org.id, "owner"],
      admin: [org.id, "admin"],
      publisher: [org.id, "publisher"],
      stranger: null,
      otherOwner: [other.id, "owner"],
    } as const;
    for (const key of ["owner", "admin", "publisher", "stranger", "otherOwner"] as const) {
      const identity = await seedIdentity(EMAILS[key], { handle: `m3orginv-${key}` });
      tokens[key] = identity.token;
      if (key === "owner") ownerAccountId = identity.account.id;
      userIds.push(identity.userId);
      const role = roles[key];
      if (role) await grantMembership(identity.account.id, role[0], role[1]);
    }
  });

  afterAll(async () => {
    await cleanupFixtures({
      organizationSlugs: [SLUG, OTHER],
      userIds,
      emails: [
        ...Object.values(EMAILS),
        ...["a", "b", "c", "d", "e", "f", "g", "dup"].map((n) => `m3orginv-${n}@rfphub.invalid`),
      ],
    });
    await app.close();
    await pool.end();
  });

  const invite = (token: string, email: string, role?: string, slug = SLUG) =>
    app.inject({
      method: "POST",
      url: `/v1/organizations/${slug}/invites`,
      headers: bearer(token),
      payload: { email, ...(role ? { role } : {}) },
    });
  const list = (token: string, slug = SLUG) =>
    app.inject({ method: "GET", url: `/v1/organizations/${slug}/invites`, headers: bearer(token) });
  const revoke = (token: string, id: number, slug = SLUG) =>
    app.inject({
      method: "DELETE",
      url: `/v1/organizations/${slug}/invites/${id}`,
      headers: bearer(token),
    });

  it("lets an owner invite any role and an admin invite admin or publisher", async () => {
    expect((await invite(tokens.owner, "m3orginv-a@rfphub.invalid", "owner")).statusCode).toBe(200);
    expect((await invite(tokens.owner, "m3orginv-b@rfphub.invalid", "admin")).statusCode).toBe(200);
    const asAdmin = await invite(tokens.admin, "m3orginv-c@rfphub.invalid");
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json()).toMatchObject({ organizationSlug: SLUG, role: "publisher" });
    expect((await invite(tokens.admin, "m3orginv-d@rfphub.invalid", "admin")).statusCode).toBe(200);
  });

  it("refuses an admin who tries to hand out ownership", async () => {
    const res = await invite(tokens.admin, "m3orginv-e@rfphub.invalid", "owner");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("owner_role_requires_owner");
  });

  it("refuses a plain publisher, a stranger, and a manager of another organization", async () => {
    for (const token of [tokens.publisher, tokens.stranger, tokens.otherOwner]) {
      const res = await invite(token, "m3orginv-f@rfphub.invalid");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_an_org_manager");
      expect((await list(token)).statusCode).toBe(403);
    }
  });

  it("404s an organization that does not exist", async () => {
    expect(
      (await invite(tokens.owner, "m3orginv-g@rfphub.invalid", "publisher", "m3orginv-nope"))
        .statusCode,
    ).toBe(404);
  });

  it("lists pending invites for a manager only", async () => {
    const res = await list(tokens.admin);
    expect(res.statusCode).toBe(200);
    const emails = res.json().items.map((row: { email: string }) => row.email);
    expect(emails).toEqual(expect.arrayContaining(["m3orginv-a@rfphub.invalid"]));
  });

  it("lets an admin revoke a publisher invite but not an owner invite", async () => {
    const pending = (await list(tokens.owner)).json().items as {
      id: number;
      email: string;
      role: string;
    }[];
    const ownerInvite = pending.find((row) => row.role === "owner");
    const publisherInvite = pending.find((row) => row.role === "publisher");
    expect(ownerInvite && publisherInvite).toBeTruthy();

    const refused = await revoke(tokens.admin, ownerInvite?.id ?? 0);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_role_requires_owner");

    expect((await revoke(tokens.admin, publisherInvite?.id ?? 0)).statusCode).toBe(200);
    expect((await revoke(tokens.owner, ownerInvite?.id ?? 0)).statusCode).toBe(200);
  });

  it("409s a duplicate pending invite and 404s revoking an unknown one", async () => {
    expect((await invite(tokens.owner, "m3orginv-dup@rfphub.invalid")).statusCode).toBe(200);
    expect((await invite(tokens.admin, "M3ORGINV-dup@rfphub.invalid")).statusCode).toBe(409);
    expect((await revoke(tokens.owner, 999_999_999)).statusCode).toBe(404);
  });

  it("refuses to invite an address that already belongs to a member", async () => {
    for (const [token, email] of [
      [tokens.admin, EMAILS.publisher],
      [tokens.owner, EMAILS.admin],
      [tokens.owner, EMAILS.owner.toUpperCase()],
    ] as const) {
      const res = await invite(token, email, "publisher");
      expect(res.statusCode, email).toBe(409);
      expect(res.json().error).toBe("already_a_member");
    }
  });

  it("lets an invite be redeemed while its creator still holds the authority", async () => {
    const created = await invite(tokens.owner, EMAILS.altStillManager, "admin");
    expect(created.statusCode).toBe(200);

    const identity = await signIn(EMAILS.altStillManager);
    userIds.push(identity.userId);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(identity.token) });
    expect(me.json().memberships).toContainEqual(
      expect.objectContaining({ slug: SLUG, role: "admin" }),
    );
  });

  async function pendingFor(email: string) {
    return db
      .select()
      .from(orgMembershipInvites)
      .where(eq(orgMembershipInvites.email, email.toLowerCase()));
  }

  it("drops an invite whose creator was removed before it was redeemed", async () => {
    const creator = await seedIdentity(EMAILS.tempAdmin, { handle: "m3orginv-temp-admin" });
    userIds.push(creator.userId);
    await grantMembership(creator.account.id, orgId, "admin");
    expect((await invite(creator.token, EMAILS.altRemoved)).statusCode).toBe(200);

    await db
      .delete(orgMemberships)
      .where(
        and(
          eq(orgMemberships.accountId, creator.account.id),
          eq(orgMemberships.organizationId, orgId),
        ),
      );

    const identity = await signIn(EMAILS.altRemoved);
    userIds.push(identity.userId);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(identity.token) });
    expect(me.json().memberships).toEqual([]);
    expect((await pendingFor(EMAILS.altRemoved)).filter((row) => row.acceptedAt === null)).toEqual(
      [],
    );
  });

  it("drops an owner invite whose creator was demoted before it was redeemed", async () => {
    const creator = await seedIdentity(EMAILS.tempOwner, { handle: "m3orginv-temp-owner" });
    userIds.push(creator.userId);
    await grantMembership(creator.account.id, orgId, "owner");
    expect((await invite(creator.token, EMAILS.altDemoted, "owner")).statusCode).toBe(200);

    await db
      .update(orgMemberships)
      .set({ role: "admin" })
      .where(
        and(
          eq(orgMemberships.accountId, creator.account.id),
          eq(orgMemberships.organizationId, orgId),
        ),
      );

    const identity = await signIn(EMAILS.altDemoted);
    userIds.push(identity.userId);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(identity.token) });
    expect(me.json().memberships).toEqual([]);
  });

  it("refuses to revoke for a publisher, a stranger and another organization's manager", async () => {
    const created = await invite(tokens.owner, "m3orginv-f@rfphub.invalid");
    expect(created.statusCode).toBe(200);
    for (const token of [tokens.publisher, tokens.stranger, tokens.otherOwner]) {
      const res = await revoke(token, created.json().id);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_an_org_manager");
    }
    expect((await revoke(tokens.owner, created.json().id)).statusCode).toBe(200);
  });

  it("is session only: no credential and an API key are both refused on all three routes", async () => {
    const apiKey = await mintApiKeyFor(ownerAccountId, ["read", "write", "publish"]);
    const routes = [
      {
        method: "POST",
        url: `/v1/organizations/${SLUG}/invites`,
        payload: { email: "m3orginv-g@rfphub.invalid" },
      },
      { method: "GET", url: `/v1/organizations/${SLUG}/invites` },
      { method: "DELETE", url: `/v1/organizations/${SLUG}/invites/1` },
    ] as const;
    for (const route of routes) {
      const anonymous = await app.inject(route);
      expect(anonymous.statusCode, `anonymous ${route.method}`).toBe(401);
      const keyed = await app.inject({ ...route, headers: bearer(apiKey) });
      expect([401, 403], `api key ${route.method}`).toContain(keyed.statusCode);
    }
  });

  it("documents a 429 on the metered routes and none on the unmetered list", async () => {
    const doc = (await app.inject({ method: "GET", url: "/v1/docs/json" })).json();
    const paths = doc.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    const invites = paths["/v1/organizations/{slug}/invites"];
    expect(invites?.post?.responses["429"]).toBeTruthy();
    expect(invites?.get?.responses["429"]).toBeUndefined();
    expect(
      paths["/v1/organizations/{slug}/invites/{inviteId}"]?.delete?.responses["429"],
    ).toBeTruthy();
  });
});
