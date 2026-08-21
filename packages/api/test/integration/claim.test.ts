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
  seedIdentity,
  seedOrganization,
  testAuth,
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
const EMAILS = {
  host: "m3claim-host@rfphub.invalid",
  rival: "m3claim-rival@rfphub.invalid",
  operator: "m3claim-operator@rfphub.invalid",
  colleague: "m3claim-colleague@rfphub.invalid",
  sponsor: "m3claim-sponsor@rfphub.invalid",
  unverified: "m3claim-unverified@rfphub.invalid",
  reviewer: "m3claim-reviewer@rfphub.invalid",
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
  const userIds: string[] = [];

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
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const rival = await seedIdentity(EMAILS.rival, { handle: "m3claim-rival" });
    const operator = await seedIdentity(EMAILS.operator, { handle: "m3claim-operator" });
    const colleague = await seedIdentity(EMAILS.colleague, { handle: "m3claim-colleague" });
    const sponsor = await seedIdentity(EMAILS.sponsor, { handle: "m3claim-sponsor" });
    const unverified = await seedIdentity(EMAILS.unverified, { handle: "m3claim-unverified" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3claim-reviewer",
      role: "reviewer",
    });
    operatorId = operator.account.id;
    userIds.push(
      rival.userId,
      operator.userId,
      colleague.userId,
      sponsor.userId,
      unverified.userId,
      reviewer.userId,
    );

    await seedOrganization({ slug: HOST, verified: false });
    const rivalOrg = await seedOrganization({ slug: RIVAL, verified: true });
    const operatorOrg = await seedOrganization({ slug: OPERATOR, verified: true });
    const sponsorOrg = await seedOrganization({ slug: SPONSOR, verified: true });
    const unverifiedOrg = await seedOrganization({ slug: UNVERIFIED, verified: false });
    operatorOrgId = operatorOrg.id;

    await grantMembership(rival.account.id, rivalOrg.id, "owner");
    await grantMembership(operator.account.id, operatorOrg.id, "owner");
    await grantMembership(colleague.account.id, operatorOrg.id, "publisher");
    await grantMembership(sponsor.account.id, sponsorOrg.id, "owner");
    await grantMembership(unverified.account.id, unverifiedOrg.id, "owner");

    rivalToken = rival.token;
    operatorToken = operator.token;
    colleagueToken = colleague.token;
    sponsorToken = sponsor.token;
    unverifiedToken = unverified.token;
    reviewerToken = reviewer.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3claim-",
      organizationSlugs: [HOST, OPERATOR, SPONSOR, RIVAL, UNVERIFIED],
      userIds,
      emails: Object.values(EMAILS),
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

  it("keeps a claimed entry writable under its immutable id, and auto-approves the write", async () => {
    // THE WHOLE POINT OF A CLAIM: an aggregator filed `host:…`, the organisation that runs the
    // programme claimed it, and the id did not move — ids are immutable. The namespace a write is
    // authorized against is therefore the ROW's publisher, not the id's prefix; deriving it from
    // the prefix would reject every update the claim promised.
    const id = await seedEntry("writable");
    expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(200);

    const replaced = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(operatorToken),
      payload: submission(id, HOST, {
        title: "Updated by its publisher",
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: OPERATOR, slug: OPERATOR },
        ],
      } as Record<string, unknown>),
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().reviewStatus).toBe("approved");
    expect(replaced.json().opportunity.title).toBe("Updated by its publisher");

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.publicId).toBe(id);
    expect(row?.sourcePublisher).toBe(OPERATOR);
    // …and the cross-system key stays pinned to the id it was created under, so a claim cannot
    // move one half of `ux_opp_source` out from under whoever resolves against it.
    expect(row?.sourceSystem).toBe(HOST);
  });

  it("is idempotent when two colleagues file the same claim at the same instant", async () => {
    // Both requests read "no pending claim" before either inserts, so the partial unique index is
    // the only arbiter and one insert raises 23505. That is a race, not a failure: the claim is
    // the ORGANISATION's, so the loser is answered with the winning claim rather than a 500.
    const id = await seedEntry("concurrent", [HOST], [OPERATOR]);
    const [first, second] = await Promise.all([
      claim(operatorToken, id, OPERATOR, "ours"),
      claim(colleagueToken, id, OPERATOR, "also ours"),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
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

  it("400s a malformed claim body instead of 500ing on a non-string field", async () => {
    const id = await seedEntry("malformed-body");

    // A non-string `organizationSlug` used to reach `ClaimService`'s `.trim()` unvalidated: the
    // plugin's pass-through validator (installed for the opportunity-write routes' humanized
    // reports) used to apply to this route too. It is now scoped to those two routes only, so
    // this route gets Fastify's ordinary schema validation.
    const badType = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(operatorToken),
      payload: { organizationSlug: {} },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe("bad_request");

    const missingBody = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(operatorToken),
    });
    expect(missingBody.statusCode).toBe(400);

    const extraProperty = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(operatorToken),
      payload: { organizationSlug: OPERATOR, unexpected: "nope" },
    });
    expect(extraProperty.statusCode).toBe(400);
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
