/**
 * The claim path under a chosen schedule: what a grant does when the verification it rests on is
 * being withdrawn, and which row a reviewer's decision holds while it waits.
 *
 * Both use the barrier connection from `test/helpers/lock-barrier.ts` rather than repetition — a
 * race asserted by running something a hundred times is a race asserted on a fast machine only.
 *
 * Isolation tag: `M3CLAIMCONC` / `m3claimconc-host:`.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  bearer,
  grantMembership,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
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
const DIDS = {
  operator: "did:privy:m3claimconc-operator",
  pender: "did:privy:m3claimconc-pender",
  reviewer: "did:privy:m3claimconc-reviewer",
};

const run = describeWithDb;
const ingest = new OpportunityService();

run("M3CLAIMCONC claims under a chosen schedule", () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let penderToken: string;
  let reviewerToken: string;
  let operatorOrgId: number;

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
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const operator = await seedAccount({ did: DIDS.operator, handle: "m3claimconc-operator" });
    const pender = await seedAccount({ did: DIDS.pender, handle: "m3claimconc-pender" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3claimconc-reviewer", role: "reviewer" });

    await seedOrganization({ slug: HOST, verified: false });
    const operatorOrg = await seedOrganization({ slug: OPERATOR, verified: true });
    const penderOrg = await seedOrganization({ slug: PENDER, verified: false });
    await grantMembership(operator.id, operatorOrg.id);
    await grantMembership(pender.id, penderOrg.id);
    operatorOrgId = operatorOrg.id;

    operatorToken = await mintPrivyToken(DIDS.operator);
    penderToken = await mintPrivyToken(DIDS.pender);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
  }, 30_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: HOST,
      organizationSlugs: [HOST, OPERATOR, PENDER],
      privyDids: Object.values(DIDS),
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
});
