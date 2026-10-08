import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { accounts, auditLog, opportunities } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const ORG = "submitter-transfer-org";
const emails = [
  "submitter-transfer-admin@rfphub.invalid",
  "submitter-transfer-owner@rfphub.invalid",
  "submitter-transfer-target@rfphub.invalid",
  "submitter-transfer-original@rfphub.invalid",
  "submitter-transfer-reviewer@rfphub.invalid",
] as const;

describeWithDb("Administrative submission attribution", () => {
  let app: FastifyInstance;
  let admin: Awaited<ReturnType<typeof seedIdentity>>;
  let owner: Awaited<ReturnType<typeof seedIdentity>>;
  let target: Awaited<ReturnType<typeof seedIdentity>>;
  let original: Awaited<ReturnType<typeof seedIdentity>>;
  let reviewer: Awaited<ReturnType<typeof seedIdentity>>;
  let orgId: number;
  const ids: string[] = [];
  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    admin = await seedIdentity(emails[0], { handle: "submitter-transfer-admin", role: "admin" });
    owner = await seedIdentity(emails[1], { handle: "submitter-transfer-owner" });
    target = await seedIdentity(emails[2], { handle: "submitter-transfer-target" });
    original = await seedIdentity(emails[3], { handle: "submitter-transfer-original" });
    reviewer = await seedIdentity(emails[4], {
      handle: "submitter-transfer-reviewer",
      role: "reviewer",
    });
    ids.push(...[admin, owner, target, original, reviewer].map((actor) => actor.userId));
    const org = await seedOrganization({ slug: ORG, verified: true });
    orgId = org.id;
    await grantMembership(owner.account.id, orgId, "owner");
  });
  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: ORG,
      organizationSlugs: [ORG],
      userIds: ids,
      emails: [...emails],
    });
    await app.close();
    await pool.end();
  });
  async function seed(local: string) {
    const id = `${ORG}:${local}`;
    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: "Transfer fixture",
        description: "Submission attribution fixture.",
        status: "open",
        operatingOrganizations: [{ name: ORG, slug: ORG }],
        fundingDetails: { fundingType: "grant" },
        ecosystems: ["SUBMITTERTRANSFER"],
        source: {
          publisher: ORG,
          submittedBy: "submitter-transfer-original",
          submittedAt: "2026-01-01T00:00:00Z",
          ingestedVia: "import",
        },
      },
      { reviewStatus: "approved", isListed: true, sourceSystem: ORG },
    );
    await db
      .update(opportunities)
      .set({ submittedBy: original.account.id })
      .where(eq(opportunities.publicId, id));
    return id;
  }
  const assign = (
    token: string,
    id: string,
    payload: Record<string, unknown> = {
      accountId: target.account.id,
      reason: "Correct the program’s responsible submitter.",
    },
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/opportunities/${id}/submitter`,
      headers: bearer(token),
      payload,
    });
  const rowFor = async (id: string) => {
    const row = (await db.select().from(opportunities).where(eq(opportunities.publicId, id)))[0];
    if (!row) throw new Error(`missing fixture ${id}`);
    return row;
  };
  const access = (token: string, id: string) =>
    app.inject({ method: "GET", url: `/v1/me/opportunities/${id}/access`, headers: bearer(token) });

  it("assigns a recipient while preserving publisher, dates, team access and the actor’s audit identity", async () => {
    const id = await seed("assign");
    const before = await rowFor(id);
    expect((await access(admin.token, id)).json().canAssignSubmission).toBe(true);
    expect((await access(owner.token, id)).json().canAssignSubmission).toBe(false);
    const response = await assign(admin.token, id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source.submittedBy).toBe(target.account.handle);
    const after = await rowFor(id);
    expect(after.submittedBy).toBe(target.account.id);
    expect(after.sourcePublisher).toBe(before.sourcePublisher);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.sourceSubmittedAt).toEqual(before.sourceSubmittedAt);
    expect(after.reviewStatus).toBe(before.reviewStatus);
    expect(after.isListed).toBe(before.isListed);
    const trail = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, after.id),
          eq(auditLog.action, "update"),
        ),
      );
    const transfer = trail.find((record) => record.patch?.reason === "submitter_transfer");
    expect(transfer?.actorAccountId).toBe(admin.account.id);
    expect(transfer?.patch?.explanation).toBe("Correct the program’s responsible submitter.");
    expect(transfer?.patch?.submittedByAccountId).toEqual({
      before: original.account.id,
      after: target.account.id,
    });
    expect((await access(owner.token, id)).json().canEdit).toBe(true);
    // Personal attribution alone does not add organization membership or editing permission.
    expect((await access(target.token, id)).json().canEdit).toBe(false);
    expect((await access(original.token, id)).json().canEdit).toBe(false);
    await grantMembership(target.account.id, orgId, "publisher");
    for (const actor of [owner, target]) {
      expect((await access(actor.token, id)).json().canEdit).toBe(true);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/insights/opportunities/${id}`,
            headers: bearer(actor.token),
          })
        ).statusCode,
      ).toBe(200);
      const updated = await app.inject({
        method: "PUT",
        url: `/v1/opportunities/${id}`,
        headers: bearer(actor.token),
        payload: { ...response.json<Record<string, unknown>>(), title: "Updated by the team" },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().opportunity.source.submittedBy).toBe(target.account.handle);
    }
    expect((await rowFor(id)).submittedBy).toBe(target.account.id);
    const repeat = await assign(admin.token, id);
    expect(repeat.statusCode).toBe(200);
    const repeatTrail = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, after.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(
      repeatTrail.filter((record) => record.patch?.reason === "submitter_transfer"),
    ).toHaveLength(1);
  });

  it("requires a global administrator session, including for keys belonging to administrators", async () => {
    const id = await seed("permissions");
    for (const actor of [owner, target, reviewer])
      expect((await assign(actor.token, id)).statusCode).toBe(403);
    const key = await mintApiKeyFor(admin.account.id, ["read", "write", "publish"]);
    expect((await assign(key, id)).statusCode).toBe(403);
    expect((await rowFor(id)).submittedBy).toBe(original.account.id);
  });

  it("validates the recipient and reason without changing the submission", async () => {
    const id = await seed("validation");
    for (const payload of [
      { accountId: target.account.id, reason: " " },
      { accountId: target.account.id },
      { accountId: 0, reason: "Correction" },
      { accountId: target.account.id, reason: "x".repeat(1001) },
    ])
      expect((await assign(admin.token, id, payload)).statusCode).toBe(400);
    expect(
      (await assign(admin.token, id, { accountId: 2147483647, reason: "Correction" })).statusCode,
    ).toBe(404);
    await db
      .update(accounts)
      .set({ handle: null, displayName: null })
      .where(eq(accounts.id, target.account.id));
    try {
      const refused = await assign(admin.token, id);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe("public_name_required");
    } finally {
      await db
        .update(accounts)
        .set({ handle: target.account.handle })
        .where(eq(accounts.id, target.account.id));
    }
    expect((await rowFor(id)).submittedBy).toBe(original.account.id);
  });

  it("refuses attribution to an orphan account or a merged program", async () => {
    const id = await seed("orphan");
    const orphan = (
      await db
        .insert(accounts)
        .values({ handle: "submitter-transfer-orphan", authUserId: null })
        .returning()
    )[0];
    if (!orphan) throw new Error("missing orphan fixture");
    try {
      const response = await assign(admin.token, id, {
        accountId: orphan.id,
        reason: "Correction",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("unreachable_account");
    } finally {
      await db.delete(accounts).where(eq(accounts.id, orphan.id));
    }
    const survivor = await seed("survivor");
    await db
      .update(opportunities)
      .set({ mergedIntoId: (await rowFor(survivor)).id })
      .where(eq(opportunities.publicId, id));
    const response = await assign(admin.token, id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("opportunity_merged");
  });
});
