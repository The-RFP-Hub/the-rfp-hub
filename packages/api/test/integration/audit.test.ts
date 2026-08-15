/**
 * The audit trail: one row per mutation, the right subject for the admin actions, the public/owner
 * redaction split — and the database trigger that makes "append-only" a property of the storage
 * rather than a promise made by the code.
 *
 * Isolation tag: `M3AUDIT` / `m3audit:`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities } from "../../src/db/schema.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3audit";
const DIDS = {
  publisher: "did:privy:m3audit-publisher",
  admin: "did:privy:m3audit-admin",
  stranger: "did:privy:m3audit-stranger",
  // A separate subject for the admin grants: promoting the stranger would change what the
  // redaction and visibility cases below are testing.
  target: "did:privy:m3audit-target",
};

const run = describeWithDb;

async function rowsFor(subjectKind: "opportunity" | "account" | "api_key", subjectId: number) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectKind, subjectKind), eq(auditLog.subjectId, subjectId)))
    .orderBy(auditLog.id);
}

run("M3AUDIT the append-only trail", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let adminToken: string;
  let strangerToken: string;
  let publishKey: string;
  let publishKeyId: number;
  let publisherId: number;
  let opportunityId: number;

  const PUBLIC_ID = `${NS}:tracked`;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3audit-publisher" });
    publisherId = publisher.id;
    await seedAccount({ did: DIDS.admin, handle: "m3audit-admin", role: "admin" });
    await seedAccount({ did: DIDS.stranger, handle: "m3audit-stranger" });
    await seedAccount({ did: DIDS.target, handle: "m3audit-target" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.id, org.id, "owner");

    publisherToken = await mintPrivyToken(DIDS.publisher);
    adminToken = await mintPrivyToken(DIDS.admin);
    strangerToken = await mintPrivyToken(DIDS.stranger);

    const minted = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: bearer(publisherToken),
      payload: { name: "m3audit", scopes: ["read", "write", "publish"] },
    });
    publishKey = minted.json().token;
    publishKeyId = minted.json().key.id;

    await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publishKey),
      payload: submission(PUBLIC_ID, NS),
    });
    await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${PUBLIC_ID}`,
      headers: bearer(publishKey),
      payload: submission(PUBLIC_ID, NS, { title: "Updated title" }),
    });
    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, PUBLIC_ID)).limit(1)
    )[0];
    opportunityId = row?.id ?? 0;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  it("records the acting key, not merely the acting account", async () => {
    const rows = await rowsFor("opportunity", opportunityId);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("create");
    expect(actions).toContain("update");
    // An auto-approval is a SECOND decision and gets its own row.
    expect(actions).toContain("approve");
    for (const row of rows) {
      expect(row.actorKind).toBe("api_key");
      expect(row.actorAccountId).toBe(publisherId);
      expect(row.actorApiKeyId).toBe(publishKeyId);
    }
  });

  it("records key creation on the KEY, and a role grant on the ACCOUNT", async () => {
    const keyRows = await rowsFor("api_key", publishKeyId);
    expect(keyRows.map((r) => r.action)).toContain("create_api_key");

    const target = await seedAccount({ did: DIDS.target });
    const granted = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${target.id}/role`,
      headers: bearer(adminToken),
      payload: { role: "reviewer" },
    });
    expect(granted.statusCode).toBe(200);
    const accountRows = await rowsFor("account", target.id);
    expect(accountRows.map((r) => r.action)).toContain("assign_role");

    const directCreate = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${target.id}/direct-create`,
      headers: bearer(adminToken),
      payload: { directCreate: true },
    });
    expect(directCreate.statusCode).toBe(200);
    expect((await rowsFor("account", target.id)).map((r) => r.action)).toContain(
      "grant_direct_create",
    );
  });

  it("gives the public field names and a coarse actor, and the owner the full patch", async () => {
    const anon = await app.inject({ method: "GET", url: `/v1/opportunities/${PUBLIC_ID}/audit` });
    expect(anon.statusCode).toBe(200);
    const entries = anon.json().entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.patch).toBeUndefined();
      expect(Array.isArray(entry.changedFields)).toBe(true);
      expect(typeof entry.actor).toBe("string");
    }
    const update = entries.find((e: { action: string }) => e.action === "update");
    expect(update.changedFields).toContain("title");

    const owner = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${PUBLIC_ID}/audit`,
      headers: bearer(publisherToken),
    });
    const ownerUpdate = owner.json().entries.find((e: { action: string }) => e.action === "update");
    expect(ownerUpdate.patch.title.after).toBe("Updated title");

    // A reviewer/admin sees it too; an unrelated account does not.
    const stranger = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${PUBLIC_ID}/audit`,
      headers: bearer(strangerToken),
    });
    expect(
      stranger.json().entries.find((e: { action: string }) => e.action === "update").patch,
    ).toBeUndefined();
  });

  it("404s the trail of a non-public entry for everyone but its owner and a reviewer", async () => {
    const pendingId = `${NS}:hidden`;
    await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(strangerToken),
      payload: submission(pendingId, NS),
    });

    const anon = await app.inject({ method: "GET", url: `/v1/opportunities/${pendingId}/audit` });
    expect(anon.statusCode).toBe(404);

    const owner = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${pendingId}/audit`,
      headers: bearer(strangerToken),
    });
    expect(owner.statusCode).toBe(200);

    const admin = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${pendingId}/audit`,
      headers: bearer(adminToken),
    });
    expect(admin.statusCode).toBe(200);
  });

  it("refuses a direct UPDATE or DELETE at the DATABASE, not merely in the code", async () => {
    const rows = await rowsFor("opportunity", opportunityId);
    const target = rows[0];
    expect(target).toBeTruthy();

    await expect(
      db
        .update(auditLog)
        .set({ action: "reject" })
        .where(eq(auditLog.id, target?.id ?? 0)),
    ).rejects.toThrow(/append-only|audit/i);

    await expect(db.delete(auditLog).where(eq(auditLog.id, target?.id ?? 0))).rejects.toThrow(
      /append-only|audit/i,
    );
  });
});
