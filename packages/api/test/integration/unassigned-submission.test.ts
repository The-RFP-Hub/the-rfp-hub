import type { Opportunity } from "@the-rfp-hub/standard";
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
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const HOST = "unassigned-submission-host";
const OPERATOR = "unassigned-submission-operator";
const emails = ["admin", "other-admin", "owner", "community", "reviewer"].map(
  (role) => `unassigned-submission-${role}@rfphub.invalid`,
);

describeWithDb("Administrative catalog creation without personal ownership", () => {
  let app: FastifyInstance;
  let actors: Awaited<ReturnType<typeof seedIdentity>>[];
  const actor = (index: number) => {
    const found = actors[index];
    if (!found) throw new Error(`missing actor ${index}`);
    return found;
  };
  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    actors = await Promise.all(
      emails.map((email, index) =>
        seedIdentity(email, {
          handle: `unassigned-submission-${index}`,
          role: index < 2 ? "admin" : index === 4 ? "reviewer" : "submitter",
          directCreate: index < 2,
        }),
      ),
    );
    await seedOrganization({ slug: HOST, verified: false });
    const org = await seedOrganization({ slug: OPERATOR, verified: true });
    await grantMembership(actor(2).account.id, org.id, "owner");
  });
  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "unassigned-submission",
      organizationSlugs: [HOST, OPERATOR],
      userIds: actors.map((actor) => actor.userId),
      emails,
    });
    await app.close();
    await pool.end();
  });
  const row = async (id: string) => {
    const found = (await db.select().from(opportunities).where(eq(opportunities.publicId, id)))[0];
    if (!found) throw new Error(`missing opportunity ${id}`);
    return found;
  };
  const create = (index: number, document: Record<string, unknown>, unassigned = true) =>
    app.inject({
      method: "POST",
      url: `/v1/opportunities${unassigned ? "?attribution=unassigned" : ""}`,
      headers: bearer(actor(index).token),
      payload: document,
    });
  const access = async (id: string) =>
    (
      await app.inject({
        method: "GET",
        url: `/v1/me/opportunities/${id}/access`,
        headers: bearer(actor(2).token),
      })
    ).json();

  it("records the admin actor without assigning a personal submitter, and permits a later operator claim", async () => {
    const id = `${HOST}:catalog`;
    const document = submission(id, HOST, {
      operatingOrganizations: [
        { name: HOST, slug: HOST },
        { name: OPERATOR, slug: OPERATOR },
      ],
      source: { submittedBy: "forged-person" },
    });
    const created = await create(0, document);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().opportunity.source.submittedBy).toBeUndefined();
    expect((await row(id)).submittedBy).toBeNull();
    const history = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, (await row(id)).id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(history).toEqual([
      expect.objectContaining({
        actorAccountId: actor(0).account.id,
        patch: expect.objectContaining({ submitterAttribution: "unassigned" }),
      }),
    ]);
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}/claim-status` })).json()
        .canClaim,
    ).toBe(true);
    const claimed = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(actor(2).token),
      payload: { organizationSlug: OPERATOR },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect((await row(id)).sourcePublisher).toBe(OPERATOR);
    expect((await access(id)).canEdit).toBe(true);
  });

  it("verified publisher members can manage a personally submitted program without claiming it", async () => {
    const id = `${OPERATOR}:personal`;
    expect((await create(3, submission(id, OPERATOR), false)).statusCode).toBe(201);
    expect((await row(id)).submittedBy).toBe(actor(3).account.id);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${id}/approve`,
      headers: bearer(actor(0).token),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await access(id)).toMatchObject({
      canEdit: true,
      canViewManagement: true,
      canClaim: false,
    });
    const claim = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(actor(2).token),
      payload: { organizationSlug: OPERATOR },
    });
    expect(claim.statusCode).toBe(409);
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(actor(2).token),
      payload: submission(id, OPERATOR, { title: "Maintained by Prezenti-shaped owner" }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
  });

  it("keeps personally unassigned creates and legacy imports unassigned after editorial edits", async () => {
    for (const imported of [false, true]) {
      const id = `${HOST}:edit-${imported}`;
      const document = submission(id, HOST);
      if (imported)
        await new OpportunityService().upsertFromStandard(
          {
            ...document,
            source: { publisher: HOST, submittedBy: "Legacy attribution", ingestedVia: "import" },
          } as unknown as Opportunity,
          { reviewStatus: "approved", isListed: true, sourceSystem: HOST },
        );
      else expect((await create(0, document)).statusCode).toBe(201);
      const edited = await app.inject({
        method: "PUT",
        url: `/v1/opportunities/${id}`,
        headers: bearer(actor(0).token),
        payload: { ...document, title: "Editorial correction" },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect((await row(id)).submittedBy).toBeNull();
      expect((await row(id)).sourceSubmittedBy).toBe(imported ? "Legacy attribution" : null);
      expect(
        (await app.inject({ method: "GET", url: `/v1/opportunities/${id}/claim-status` })).json()
          .canClaim,
      ).toBe(true);
    }
  });

  it("does not attach a verified publisher editor's account to an unassigned program", async () => {
    const id = `${OPERATOR}:team-edit`;
    expect((await create(0, submission(id, OPERATOR))).statusCode).toBe(201);
    expect(await access(id)).toMatchObject({ canEdit: true, canClaim: false });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/opportunities/${id}`,
          headers: bearer(actor(2).token),
          payload: submission(id, OPERATOR, { title: "Team correction" }),
        })
      ).statusCode,
    ).toBe(200);
    expect((await row(id)).submittedBy).toBeNull();
    expect((await row(id)).sourceSubmittedBy).toBeNull();
  });

  it("recognizes retries only for the audited creator with the same attribution intent", async () => {
    const document = submission(`${HOST}:retry`, HOST);
    expect((await create(0, document)).statusCode).toBe(201);
    expect((await create(0, document)).statusCode).toBe(200);
    expect((await create(1, document)).statusCode).toBe(409);
    expect((await create(0, document, false)).statusCode).toBe(409);
    expect((await create(3, document, false)).statusCode).toBe(409);
  });

  it("refuses non-admin sessions, admin keys, invalid attribution and disabling attribution on replace", async () => {
    for (const index of [2, 3, 4])
      expect((await create(index, submission(`${HOST}:refused-${index}`, HOST))).statusCode).toBe(
        403,
      );
    const key = await mintApiKeyFor(actor(0).account.id, ["read", "write", "publish"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/opportunities?attribution=unassigned",
          headers: bearer(key),
          payload: submission(`${HOST}:key`, HOST),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/opportunities?attribution=invalid",
          headers: bearer(actor(0).token),
          payload: submission(`${HOST}:invalid`, HOST),
        })
      ).statusCode,
    ).toBe(400);
    const id = `${HOST}:replace-flag`;
    expect((await create(0, submission(id, HOST), false)).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/opportunities/${id}?attribution=unassigned`,
          headers: bearer(actor(0).token),
          payload: submission(id, HOST),
        })
      ).statusCode,
    ).toBe(400);
    expect((await row(id)).submittedBy).toBe(actor(0).account.id);
  });

  it("unassigned catalog creation still requires publication authority or a review decision", async () => {
    await db
      .update(accounts)
      .set({ directCreate: false })
      .where(eq(accounts.id, actor(1).account.id));
    try {
      const id = `${HOST}:review-required`;
      const created = await create(1, submission(id, HOST));
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().reviewStatus).toBe("pending");
      expect((await row(id)).submittedBy).toBeNull();
      expect(
        (await app.inject({ method: "GET", url: `/v1/opportunities/${id}/claim-status` }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/review/opportunities/${id}/approve`,
            headers: bearer(actor(0).token),
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: `/v1/opportunities/${id}/claim-status` })).json()
          .canClaim,
      ).toBe(true);
    } finally {
      await db
        .update(accounts)
        .set({ directCreate: true })
        .where(eq(accounts.id, actor(1).account.id));
    }
  });

  it("rechecks the administrator role under the account lock before creating", async () => {
    const barrier = await openLockBarrier();
    try {
      await barrier.run("update accounts set global_role = 'submitter' where id = $1", [
        actor(1).account.id,
      ]);
      const pending = create(1, submission(`${HOST}:revoked-admin`, HOST));
      await barrier.waitForWaiters(1);
      await barrier.commit();
      const response = await pending;
      expect(response.statusCode, response.body).toBe(403);
      expect(
        await db
          .select()
          .from(opportunities)
          .where(eq(opportunities.publicId, `${HOST}:revoked-admin`)),
      ).toHaveLength(0);
    } finally {
      await barrier.rollback();
      await db
        .update(accounts)
        .set({ globalRole: "admin" })
        .where(eq(accounts.id, actor(1).account.id));
    }
  }, 30_000);
});
