/**
 * The claim path under a chosen schedule: what a grant does when the verification it rests on is
 * being withdrawn, and which row a reviewer's decision holds while it waits.
 *
 * Both use the barrier connection from `test/helpers/lock-barrier.ts` rather than repetition — a
 * race asserted by running something a hundred times is a race asserted on a fast machine only.
 *
 * Isolation tag: `M3CLAIMCONC` / `m3claimconc-host:`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import {
  auditLog,
  notifications,
  opportunities,
  opportunityClaims,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { describeWithDb } from "./db-gate.js";

/** An unverified aggregator namespace, the shape a claim exists for. */
const HOST = "m3claimconc-host";
/** Verified, and an operating organisation of the entry: a claim from it is granted outright. */
const OPERATOR = "m3claimconc-operator";
/** Unverified, so its claim is queued for a reviewer instead. */
const PENDER = "m3claimconc-pender";
const EMAILS = {
  operator: "m3claimconc-operator@rfphub.invalid",
  pender: "m3claimconc-pender@rfphub.invalid",
  reviewer: "m3claimconc-reviewer@rfphub.invalid",
};

const run = describeWithDb;
const ingest = new OpportunityService();

run("M3CLAIMCONC claims under a chosen schedule", () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let penderToken: string;
  let reviewerToken: string;
  let operatorOrgId: number;
  let penderAccountId: number;
  let penderOrgId: number;
  const userIds: string[] = [];

  /** One approved, listed entry published under `HOST` and operated by everyone who claims it. */
  async function seedEntry(localId: string) {
    const id = `${HOST}:${localId}`;
    await ingest.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: `Claimable ${localId}`,
        description: "A claimable fixture.",
        status: "open",
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: OPERATOR, slug: OPERATOR },
          { name: PENDER, slug: PENDER },
        ],
        source: { publisher: HOST, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3CLAIMCONC"],
        fundingDetails: { fundingType: "grant" },
      },
      { reviewStatus: "approved", isListed: true, sourceSystem: HOST },
    );
    return id;
  }

  const publisherOf = async (publicId: string) =>
    (
      await db
        .select({ publisher: opportunities.sourcePublisher, id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.publicId, publicId))
        .limit(1)
    )[0];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const operator = await seedIdentity(EMAILS.operator, { handle: "m3claimconc-operator" });
    const pender = await seedIdentity(EMAILS.pender, { handle: "m3claimconc-pender" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3claimconc-reviewer",
      role: "reviewer",
    });
    userIds.push(operator.userId, pender.userId, reviewer.userId);

    await seedOrganization({ slug: HOST, verified: false });
    const operatorOrg = await seedOrganization({ slug: OPERATOR, verified: true });
    const penderOrg = await seedOrganization({ slug: PENDER, verified: false });
    await grantMembership(operator.account.id, operatorOrg.id);
    await grantMembership(pender.account.id, penderOrg.id);
    operatorOrgId = operatorOrg.id;
    penderAccountId = pender.account.id;
    penderOrgId = penderOrg.id;

    operatorToken = operator.token;
    penderToken = pender.token;
    reviewerToken = reviewer.token;
  }, 30_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: HOST,
      organizationSlugs: [HOST, OPERATOR, PENDER],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  }, 30_000);

  it("refuses a grant when the organisation is un-verified before it commits", async () => {
    const id = await seedEntry("withdrawn");

    const barrier = await openLockBarrier();
    let claimed: Awaited<ReturnType<typeof app.inject>>;
    try {
      // Uncommitted: the verification is being withdrawn, and the claim below is decided against a
      // row that still says `verified = true` in every snapshot taken before this commits.
      await barrier.run("update organizations set verified = false where id = $1", [operatorOrgId]);
      const pending = app.inject({
        method: "POST",
        url: `/v1/opportunities/${id}/claim`,
        headers: bearer(operatorToken),
        payload: { organizationSlug: OPERATOR },
      });
      // The grant can only block here because it locks the organisation row it derives the answer
      // from. A plain read would have sailed past and transferred ownership on a verification that
      // no longer exists — so this wait is the regression assertion.
      await barrier.waitForWaiters(1);
      await barrier.commit();
      claimed = await pending;
    } finally {
      await barrier.rollback();
      await seedOrganization({ slug: OPERATOR, verified: true });
    }

    expect(claimed.statusCode, claimed.body).toBe(403);
    expect(claimed.json().error).toBe("claim_not_grantable");
    // Ownership stayed where it was: the refusal is the whole point, not a cosmetic status code.
    expect((await publisherOf(id))?.publisher).toBe(HOST);
  }, 30_000);

  it("holds the entry, not the claim, while a decision waits", async () => {
    // THE DEADLOCK THIS FORECLOSES. A grant takes the entry first and settles the claim row last.
    // A decision that took the claim first and then waited for the same entry would close the cycle
    // — a member retrying their claim while a reviewer decides it — and PostgreSQL would answer one
    // of them with a deadlock instead of a decision.
    const id = await seedEntry("ordered");
    const queued = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(penderToken),
      payload: { organizationSlug: PENDER },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    const claimId = queued.json().claimId as number;

    const entryLock = await openLockBarrier();
    const probe = await openLockBarrier();
    let decided: Awaited<ReturnType<typeof app.inject>>;
    try {
      await entryLock.run("select id from opportunities where public_id = $1 for update", [id]);
      const pending = app.inject({
        method: "POST",
        url: `/v1/review/claims/${claimId}/approve`,
        headers: bearer(reviewerToken),
        payload: { verifyOrganization: true },
      });
      await entryLock.waitForWaiters(1);

      // The decision is parked on the ENTRY. If it were holding the claim row while it waited, this
      // would raise `55P03` instead of returning; that it returns is the lock order, asserted.
      await expect(
        probe.run("select id from opportunity_claims where id = $1 for update nowait", [claimId]),
      ).resolves.toBeUndefined();
      await probe.rollback();
      await entryLock.rollback();
      decided = await pending;
    } finally {
      await probe.rollback();
      await entryLock.rollback();
    }

    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().outcome).toBe("granted");
    expect((await publisherOf(id))?.publisher).toBe(PENDER);
  }, 30_000);
  it("serializes approval behind verification withdrawal and restores verification atomically", async () => {
    await seedOrganization({ slug: PENDER, verified: false });
    const id = await seedEntry("approval-reverification");
    const queued = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(penderToken),
      payload: { organizationSlug: PENDER },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    await seedOrganization({ slug: PENDER, verified: true });
    const barrier = await openLockBarrier();
    try {
      await barrier.run("update organizations set verified = false where id = $1", [penderOrgId]);
      const pending = app.inject({
        method: "POST",
        url: `/v1/review/claims/${queued.json().claimId}/approve`,
        headers: bearer(reviewerToken),
        payload: { verifyOrganization: false },
      });
      await barrier.waitForWaiters(1);
      await barrier.commit();
      const approved = await pending;
      expect(approved.statusCode, approved.body).toBe(200);
      expect(
        (await db.select().from(organizations).where(eq(organizations.id, penderOrgId)))[0]
          ?.verified,
      ).toBe(true);
      expect((await publisherOf(id))?.publisher).toBe(PENDER);
    } finally {
      await barrier.rollback();
    }
  }, 30_000);

  it("keeps an already-verified organization unchanged when two reviewers race", async () => {
    // Not an operator of this listing, so the verified organization's claim still queues.
    await seedOrganization({ slug: PENDER, verified: true });
    const id = await seedEntry("approval-race");
    await db
      .update(opportunities)
      .set({ operatingOrganizations: [{ name: HOST, slug: HOST }] })
      .where(eq(opportunities.publicId, id));
    const queued = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(penderToken),
      payload: { organizationSlug: PENDER },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    const beforeOrg = (
      await db.select().from(organizations).where(eq(organizations.id, penderOrgId))
    )[0];
    const beforeEmails = await db
      .select()
      .from(notifications)
      .where(eq(notifications.accountId, penderAccountId));
    const barrier = await openLockBarrier();
    try {
      await barrier.run("select id from opportunities where public_id = $1 for update", [id]);
      const requests = [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: `/v1/review/claims/${queued.json().claimId}/approve`,
          headers: bearer(reviewerToken),
          payload: {},
        }),
      );
      await barrier.waitForWaiters(2);
      await barrier.commit();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(responses.find((response) => response.statusCode === 409)?.json().error).toBe(
        "claim_decided",
      );
    } finally {
      await barrier.rollback();
    }
    expect(
      (await db.select().from(organizations).where(eq(organizations.id, penderOrgId)))[0],
    ).toEqual(beforeOrg);
    expect(
      await db.select().from(notifications).where(eq(notifications.accountId, penderAccountId)),
    ).toEqual(beforeEmails);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.subjectKind, "claim"),
            eq(auditLog.subjectId, queued.json().claimId),
            eq(auditLog.action, "approve"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(opportunityClaims)
          .where(eq(opportunityClaims.id, queued.json().claimId))
      )[0]?.status,
    ).toBe("approved");
  }, 30_000);

  it("refuses an immediate grant after membership revocation commits", async () => {
    const id = await seedEntry("membership-revoked");
    const barrier = await openLockBarrier();
    try {
      const member = (
        await db
          .select()
          .from(orgMemberships)
          .where(eq(orgMemberships.organizationId, operatorOrgId))
      )[0];
      if (!member) throw new Error("missing operator membership");
      await barrier.run("delete from org_memberships where id = $1", [member.id]);
      const pending = app.inject({
        method: "POST",
        url: `/v1/opportunities/${id}/claim`,
        headers: bearer(operatorToken),
        payload: { organizationSlug: OPERATOR },
      });
      await barrier.waitForWaiters(1);
      await barrier.commit();
      const refused = await pending;
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("claim_not_grantable");
      expect((await publisherOf(id))?.publisher).toBe(HOST);
      await grantMembership(member.accountId, operatorOrgId, member.role);
    } finally {
      await barrier.rollback();
    }
  }, 30_000);

  it("rejects a queued claim whose request started before ownership was granted", async () => {
    const id = await seedEntry("stale-filing");
    const row = await publisherOf(id);
    if (!row) throw new Error("missing fixture");
    const barrier = await openLockBarrier();
    try {
      await barrier.run("select id from opportunities where id = $1 for update", [row.id]);
      const pending = app.inject({
        method: "POST",
        url: `/v1/opportunities/${id}/claim`,
        headers: bearer(penderToken),
        payload: { organizationSlug: PENDER },
      });
      await barrier.waitForWaiters(1);
      await barrier.run("update opportunities set source_publisher = $1 where id = $2", [
        OPERATOR,
        row.id,
      ]);
      await barrier.run(
        "insert into audit_log (subject_kind, subject_id, action, actor_kind, patch) values ('opportunity', $1, 'grant_publisher', 'user', '{}')",
        [row.id],
      );
      await barrier.commit();
      const response = await pending;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toBe("already_claimed");
    } finally {
      await barrier.rollback();
    }
  }, 30_000);

  it("allows only one immediate grant when two claims race", async () => {
    const id = await seedEntry("one-grant");
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: `/v1/opportunities/${id}/claim`,
          headers: bearer(operatorToken),
          payload: { organizationSlug: OPERATOR },
        }),
      ),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((response) => response.statusCode === 409)?.json().error).toBe(
      "already_claimed",
    );
  });
  it("serializes an account's pending cap across different opportunities", async () => {
    await seedOrganization({ slug: PENDER, verified: false });
    for (let index = 0; index < 9; index++) {
      const id = await seedEntry(`cap-existing-${index}`);
      const response = await app.inject({
        method: "POST",
        url: `/v1/opportunities/${id}/claim`,
        headers: bearer(penderToken),
        payload: { organizationSlug: PENDER },
      });
      expect(response.statusCode, response.body).toBe(202);
    }
    const ids = await Promise.all([seedEntry("cap-first"), seedEntry("cap-second")]);
    const barrier = await openLockBarrier();
    try {
      await barrier.run("select id from accounts where id = $1 for update", [penderAccountId]);
      const requests = ids.map((id) =>
        app.inject({
          method: "POST",
          url: `/v1/opportunities/${id}/claim`,
          headers: bearer(penderToken),
          payload: { organizationSlug: PENDER },
        }),
      );
      await barrier.waitForWaiters(2);
      await barrier.commit();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      expect(responses.find((response) => response.statusCode === 409)?.json().error).toBe(
        "too_many_pending_claims",
      );
    } finally {
      await barrier.rollback();
    }
  }, 30_000);
});
