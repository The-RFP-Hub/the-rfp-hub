/** Owners and admins inviting colleagues to their own organization, without a Hub reviewer. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
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
};

describeWithDb("owner and admin membership invites", () => {
  let app: FastifyInstance;
  const tokens = {} as Record<keyof typeof EMAILS, string>;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const org = await seedOrganization({ slug: SLUG, name: "Invite Org" });
    const other = await seedOrganization({ slug: OTHER, name: "Other Org" });
    const roles = {
      owner: [org.id, "owner"],
      admin: [org.id, "admin"],
      publisher: [org.id, "publisher"],
      stranger: null,
      otherOwner: [other.id, "owner"],
    } as const;
    for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
      const identity = await seedIdentity(EMAILS[key], { handle: `m3orginv-${key}` });
      tokens[key] = identity.token;
      userIds.push(identity.userId);
      const role = roles[key];
      if (role) await grantMembership(identity.account.id, role[0], role[1]);
    }
  });

  afterAll(async () => {
    await cleanupFixtures({
      organizationSlugs: [SLUG, OTHER],
      userIds,
      emails: [...Object.values(EMAILS), "m3orginv-new@rfphub.invalid"],
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
});
