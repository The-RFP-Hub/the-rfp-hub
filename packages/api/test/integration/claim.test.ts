/**
 * Claiming publisher ownership: the operating-vs-sponsoring distinction, the one-pending-claim-per
 * ORGANISATION key, the `publish`-scope bar, and the reviewer decision that carries the verification
 * choice explicitly.
 *
 * Isolation tag: `M3CLAIM` / `m3claim:`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, opportunityClaims, orgMemberships } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
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

/**
 * `HOST` is an UNVERIFIED aggregator namespace — the shape a claim exists for: somebody else filed
 * the entry, and the organisation that actually runs the programme wants it back. An entry already
 * published by a VERIFIED organisation is the conflict case, and `RIVAL` is what proves it.
 */
const HOST = "m3claim-host";
const OPERATOR = "m3claim-operator";
const SPONSOR = "m3claim-sponsor";
const RIVAL = "m3claim-rival";
const UNVERIFIED = "m3claim-unverified";
const DIDS = {
  host: "did:privy:m3claim-host",
  rival: "did:privy:m3claim-rival",
  operator: "did:privy:m3claim-operator",
  colleague: "did:privy:m3claim-colleague",
  sponsor: "did:privy:m3claim-sponsor",
  unverified: "did:privy:m3claim-unverified",
  reviewer: "did:privy:m3claim-reviewer",
};

const run = describeWithDb;
const ingest = new OpportunityService();

run("M3CLAIM ownership claims", () => {
  let app: FastifyInstance;
  let rivalToken: string;
  let operatorToken: string;
  let colleagueToken: string;
  let sponsorToken: string;
  let unverifiedToken: string;
  let reviewerToken: string;
  let operatorId: number;
  let operatorOrgId: number;

  /**
   * One approved, listed entry published under the unverified `HOST` namespace.
   *
   * Seeded through the ingest service rather than the submission route: the fixture is an entry
   * that arrived from somewhere else, which is the only situation a claim is about.
   */
  async function seedEntry(
    localId: string,
    operating: [string, ...string[]] = [HOST, OPERATOR],
    sponsoring: string[] = [SPONSOR],
  ) {
    const id = `${HOST}:${localId}`;
    await ingest.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: `Claimable ${localId}`,
        description: "A claimable fixture.",
        status: "open",
        operatingOrganizations: operating.map((slug) => ({ name: slug, slug })) as [
          { name: string; slug: string },
          ...{ name: string; slug: string }[],
        ],
        sponsoringOrganizations: sponsoring.map((slug) => ({ name: slug, slug })),
        source: { publisher: HOST, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3CLAIM"],
        fundingDetails: { fundingType: "grant" },
      },
      { reviewStatus: "approved", isListed: true, sourceSystem: HOST },
    );
    return id;
  }

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const rival = await seedAccount({ did: DIDS.rival, handle: "m3claim-rival" });
    const operator = await seedAccount({ did: DIDS.operator, handle: "m3claim-operator" });
    const colleague = await seedAccount({ did: DIDS.colleague, handle: "m3claim-colleague" });
    const sponsor = await seedAccount({ did: DIDS.sponsor, handle: "m3claim-sponsor" });
    const unverified = await seedAccount({ did: DIDS.unverified, handle: "m3claim-unverified" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3claim-reviewer", role: "reviewer" });
    operatorId = operator.id;

    await seedOrganization({ slug: HOST, verified: false });
    const rivalOrg = await seedOrganization({ slug: RIVAL, verified: true });
    const operatorOrg = await seedOrganization({ slug: OPERATOR, verified: true });
    const sponsorOrg = await seedOrganization({ slug: SPONSOR, verified: true });
    const unverifiedOrg = await seedOrganization({ slug: UNVERIFIED, verified: false });
    operatorOrgId = operatorOrg.id;

    await grantMembership(rival.id, rivalOrg.id, "owner");
    await grantMembership(operator.id, operatorOrg.id, "owner");
    await grantMembership(colleague.id, operatorOrg.id, "publisher");
    await grantMembership(sponsor.id, sponsorOrg.id, "owner");
    await grantMembership(unverified.id, unverifiedOrg.id, "owner");

    rivalToken = await mintPrivyToken(DIDS.rival);
    operatorToken = await mintPrivyToken(DIDS.operator);
    colleagueToken = await mintPrivyToken(DIDS.colleague);
    sponsorToken = await mintPrivyToken(DIDS.sponsor);
    unverifiedToken = await mintPrivyToken(DIDS.unverified);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3claim-",
      organizationSlugs: [HOST, OPERATOR, SPONSOR, RIVAL, UNVERIFIED],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  const claim = (token: string, id: string, slug: string, note?: string) =>
    app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(token),
      payload: { organizationSlug: slug, ...(note ? { note } : {}) },
    });

  it("grants immediately to a verified OPERATING organisation", async () => {
    const id = await seedEntry("grant");
    const res = await claim(operatorToken, id, OPERATOR);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("granted");
    expect(res.json().message).toMatch(/auto-approve/);

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.sourcePublisher).toBe(OPERATOR);
    expect(row?.lastSeenAt).not.toBeNull();
  });

  it("QUEUES a verified SPONSORING organisation — sponsorship is not operation", async () => {
    const id = await seedEntry("sponsor");
    const res = await claim(sponsorToken, id, SPONSOR);
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe("queued");

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    // Crucially, ownership did NOT move.
    expect(row?.sourcePublisher).toBe(HOST);
  });

  it("queues an unverified organisation even when it operates the entry", async () => {
    const id = await seedEntry("unverified-op", [HOST, UNVERIFIED], []);
    const res = await claim(unverifiedToken, id, UNVERIFIED);
    expect(res.statusCode).toBe(202);
    expect(res.json().message).toMatch(/not a verified publisher/);
  });

  it("refuses a claim on an organisation the account is not a member of", async () => {
    const id = await seedEntry("not-a-member");
    const res = await claim(sponsorToken, id, OPERATOR);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_a_member");
  });

  it("collapses two colleagues' claims into one pending row, per ORGANISATION", async () => {
    // OPERATOR only SPONSORS here, so both claims queue rather than granting.
    const id = await seedEntry("collapse", [HOST], [OPERATOR]);
    const first = await claim(operatorToken, id, OPERATOR, "ours");
    const second = await claim(colleagueToken, id, OPERATOR, "also ours");
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().claimId).toBe(first.json().claimId);

    const entry = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    const rows = await db
      .select()
      .from(opportunityClaims)
      .where(
        and(
          eq(opportunityClaims.opportunityId, entry?.id ?? 0),
          eq(opportunityClaims.status, "pending"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("loses the race to a membership revoked mid-flight", async () => {
    const id = await seedEntry("race");
    await db
      .delete(orgMemberships)
      .where(
        and(
          eq(orgMemberships.accountId, operatorId),
          eq(orgMemberships.organizationId, operatorOrgId),
        ),
      );
    // The principal is resolved per request, so the pre-transaction membership check already fails
    // here; the in-transaction re-check is what covers a revocation that lands between the two.
    const res = await claim(operatorToken, id, OPERATOR);
    expect([403]).toContain(res.statusCode);
    await grantMembership(operatorId, operatorOrgId, "owner");

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.sourcePublisher).toBe(HOST);
  });

  it("refuses a grant from an API key without `publish`, loudly", async () => {
    const id = await seedEntry("scope");
    const key = await mintApiKeyFor(operatorId, ["read", "write"]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(key),
      payload: { organizationSlug: OPERATOR },
    });
    // A silent queue would tell the caller their key is weaker than it is.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("missing_scope");
  });

  it("is a 200 no-op when the caller's organisation already publishes it", async () => {
    const id = await seedEntry("noop");
    await claim(operatorToken, id, OPERATOR);
    const again = await claim(operatorToken, id, OPERATOR);
    expect(again.statusCode).toBe(200);
    expect(again.json().outcome).toBe("unchanged");
  });

  it("409s a claim against an entry a different VERIFIED organisation already publishes", async () => {
    const id = await seedEntry("taken", [HOST, OPERATOR, RIVAL], []);
    expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(200);
    // RIVAL operates the entry too, and is verified — but OPERATOR already holds it.
    const res = await claim(rivalToken, id, RIVAL);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_claimed");
  });

  it("transfers ownership on approval WITHOUT unlocking auto-approval when the org stays unverified", async () => {
    const id = await seedEntry("queued-unverified", [HOST], [UNVERIFIED]);
    const queued = await claim(unverifiedToken, id, UNVERIFIED);
    expect(queued.statusCode).toBe(202);

    const decided = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: false },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().message).toMatch(/NOT verified/);

    // Ownership moved…
    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.sourcePublisher).toBe(UNVERIFIED);

    // …and the new publisher's next write still lands pending, which is exactly what the message
    // said would happen.
    const write = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(unverifiedToken),
      payload: submission(`${UNVERIFIED}:after-claim`, UNVERIFIED),
    });
    expect(write.json().reviewStatus).toBe("pending");
  });

  it("unlocks auto-approval when the reviewer verifies the organisation as part of the approval", async () => {
    const id = await seedEntry("queued-verify", [HOST], [UNVERIFIED]);
    const queued = await claim(unverifiedToken, id, UNVERIFIED);
    const decided = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: true },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().message).toMatch(/auto-approve/);

    const write = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(unverifiedToken),
      payload: submission(`${UNVERIFIED}:after-verify`, UNVERIFIED),
    });
    expect(write.json().reviewStatus).toBe("approved");
  });

  it("409s a second decision on an already-decided claim", async () => {
    const rows = await db
      .select()
      .from(opportunityClaims)
      .where(eq(opportunityClaims.status, "approved"))
      .limit(1);
    const decided = rows[0];
    if (!decided) return;
    const res = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${decided.id}/reject`,
      headers: bearer(reviewerToken),
    });
    expect(res.statusCode).toBe(409);
  });
});
