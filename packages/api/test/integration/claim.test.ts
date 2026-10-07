/**
 * Claiming publisher ownership: the operating-vs-sponsoring distinction, the one-pending-claim-per
 * ORGANISATION key, the `publish`-scope bar, and the reviewer decision that carries the verification
 * choice explicitly.
 *
 * Isolation tag: `M3CLAIM` / `m3claim:`.
 */
import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import {
  auditLog,
  notifications,
  opportunities,
  opportunityClaims,
  opportunityDuplicates,
  orgMemberships,
} from "../../src/db/schema.js";
import { MAX_PENDING_CLAIMS_PER_ACCOUNT } from "../../src/modules/services/claims/claim.service.js";
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
/**
 * The organisation ownership MOVES TO in the PUT-after-claim cases, kept separate from `UNVERIFIED`
 * on purpose: a later case in this file has a reviewer verify `UNVERIFIED` as part of an approval,
 * and these cases need an organisation that is still unverified when they run. That is what makes
 * them isolate the SUBMITTER arm of the write rule — a member of a VERIFIED organisation would pass
 * on the T2 arm whatever the submitter arm said, and the test would prove nothing.
 */
const CLAIMED = "m3claim-claimed";
/** The publisher of the legacy-shaped row whose id prefix disagrees with it WITHOUT any claim. */
const LEGACY_PUB = "m3claim-legacypub";
const EMAILS = {
  host: "m3claim-host@rfphub.invalid",
  rival: "m3claim-rival@rfphub.invalid",
  operator: "m3claim-operator@rfphub.invalid",
  colleague: "m3claim-colleague@rfphub.invalid",
  sponsor: "m3claim-sponsor@rfphub.invalid",
  unverified: "m3claim-unverified@rfphub.invalid",
  reviewer: "m3claim-reviewer@rfphub.invalid",
  /** A member of nothing and a reviewer of nothing — the only shape that isolates the SUBMITTER arm. */
  submitter: "m3claim-submitter@rfphub.invalid",
  /** A member of `CLAIMED`: the submitter whose own organisation later claims their entry. */
  insider: "m3claim-insider@rfphub.invalid",
  /** A member of the aggregator namespace `HOST`, so an entry can be claimed BACK to it. */
  hostMember: "m3claim-hostmember@rfphub.invalid",
  /** Holds no membership anywhere: the open-filing cases are about exactly that account. */
  stranger: "m3claim-stranger@rfphub.invalid",
  /** A second member-less account, so the pending-claim cap does not depend on test order. */
  flooder: "m3claim-flooder@rfphub.invalid",
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
  let submitterToken: string;
  let insiderToken: string;
  let hostMemberToken: string;
  let strangerToken: string;
  let strangerId: number;
  let flooderToken: string;
  let submitterId: number;
  let operatorId: number;
  let sponsorId: number;
  let unverifiedId: number;
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
    const operator = await seedIdentity(EMAILS.operator, { handle: "m3claim-manager" });
    const colleague = await seedIdentity(EMAILS.colleague, { handle: "m3claim-colleague" });
    const sponsor = await seedIdentity(EMAILS.sponsor, { handle: "m3claim-sponsor" });
    const unverified = await seedIdentity(EMAILS.unverified, { handle: "m3claim-unverified" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3claim-reviewer",
      role: "reviewer",
    });
    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m3claim-submitter" });
    const insider = await seedIdentity(EMAILS.insider, { handle: "m3claim-insider" });
    const hostMember = await seedIdentity(EMAILS.hostMember, { handle: "m3claim-hostmember" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3claim-stranger" });
    const flooder = await seedIdentity(EMAILS.flooder, { handle: "m3claim-flooder" });
    strangerId = stranger.account.id;
    strangerToken = stranger.token;
    flooderToken = flooder.token;
    submitterId = submitter.account.id;
    operatorId = operator.account.id;
    sponsorId = sponsor.account.id;
    unverifiedId = unverified.account.id;
    userIds.push(
      rival.userId,
      operator.userId,
      colleague.userId,
      sponsor.userId,
      unverified.userId,
      reviewer.userId,
      submitter.userId,
      insider.userId,
      hostMember.userId,
      stranger.userId,
      flooder.userId,
    );

    const hostOrg = await seedOrganization({ slug: HOST, verified: false });
    await seedOrganization({ slug: LEGACY_PUB, verified: false });
    const rivalOrg = await seedOrganization({ slug: RIVAL, verified: true });
    const operatorOrg = await seedOrganization({ slug: OPERATOR, verified: true });
    const sponsorOrg = await seedOrganization({ slug: SPONSOR, verified: true });
    const unverifiedOrg = await seedOrganization({ slug: UNVERIFIED, verified: false });
    const claimedOrg = await seedOrganization({ slug: CLAIMED, verified: false });
    operatorOrgId = operatorOrg.id;

    await grantMembership(rival.account.id, rivalOrg.id, "owner");
    await grantMembership(operator.account.id, operatorOrg.id, "owner");
    await grantMembership(colleague.account.id, operatorOrg.id, "publisher");
    await grantMembership(sponsor.account.id, sponsorOrg.id, "owner");
    await grantMembership(unverified.account.id, unverifiedOrg.id, "owner");
    await grantMembership(insider.account.id, claimedOrg.id, "owner");
    await grantMembership(hostMember.account.id, hostOrg.id, "owner");

    rivalToken = rival.token;
    operatorToken = operator.token;
    colleagueToken = colleague.token;
    sponsorToken = sponsor.token;
    unverifiedToken = unverified.token;
    reviewerToken = reviewer.token;
    submitterToken = submitter.token;
    insiderToken = insider.token;
    hostMemberToken = hostMember.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3claim-",
      organizationSlugs: [HOST, OPERATOR, SPONSOR, RIVAL, UNVERIFIED, CLAIMED, LEGACY_PUB],
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

  it("keeps organization access after a colleague claims, and lets its manager assume submission attribution", async () => {
    const id = await seedEntry("manager-submission");
    expect((await claim(colleagueToken, id, OPERATOR)).statusCode).toBe(200);
    // Imported historical ownership: retain coverage of transferring a previous attribution.
    await db
      .update(opportunities)
      .set({ submittedBy: submitterId })
      .where(eq(opportunities.publicId, id));
    const assume = (token: string) =>
      app.inject({
        method: "POST",
        url: `/v1/opportunities/${id}/submitter`,
        headers: bearer(token),
      });
    for (const token of [colleagueToken, rivalToken, reviewerToken]) {
      const refused = await assume(token);
      expect(refused.statusCode, refused.body).toBe(403);
    }
    const key = await mintApiKeyFor(operatorId, ["read", "write", "publish"]);
    expect((await assume(key)).statusCode).toBe(403);
    const transferred = await assume(operatorToken);
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json().source.submittedBy).toBe("m3claim-manager");
    const row = (await db.select().from(opportunities).where(eq(opportunities.publicId, id)))[0];
    expect(row?.submittedBy).toBe(operatorId);
    expect(row?.sourcePublisher).toBe(OPERATOR);
    expect(row?.reviewStatus).toBe("approved");
    if (!row) throw new Error("missing transferred program");
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, row.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(
      audit.some(
        (record) =>
          record.patch?.reason === "submitter_transfer" &&
          (record.patch?.submittedByAccountId as { before: number }).before === submitterId,
      ),
    ).toBe(true);
    expect((await assume(operatorToken)).statusCode).toBe(200);
    for (const token of [operatorToken, colleagueToken]) {
      const access = await app.inject({
        method: "GET",
        url: `/v1/me/opportunities/${id}/access`,
        headers: bearer(token),
      });
      expect(access.json().canEdit).toBe(true);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/insights/opportunities/${id}`,
            headers: bearer(token),
          })
        ).statusCode,
      ).toBe(200);
      const edited = await app.inject({
        method: "PUT",
        url: `/v1/opportunities/${id}`,
        headers: bearer(token),
        payload: submission(id, OPERATOR, {
          title: "Maintained by the organization",
          operatingOrganizations: [
            { name: HOST, slug: HOST },
            { name: OPERATOR, slug: OPERATOR },
          ],
        }),
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().opportunity.source.submittedBy).toBe("m3claim-manager");
    }
    const unchanged = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id))
    )[0];
    expect(unchanged?.submittedBy).toBe(operatorId);
    // Admin is a separate organization role, and has the same attribution authority as owner.
    await db
      .update(orgMemberships)
      .set({ role: "admin" })
      .where(
        and(
          eq(orgMemberships.accountId, operatorId),
          eq(orgMemberships.organizationId, operatorOrgId),
        ),
      );
    try {
      const adminId = await seedEntry("admin-submission");
      expect((await claim(colleagueToken, adminId, OPERATOR)).statusCode).toBe(200);
      const adminTransfer = await app.inject({
        method: "POST",
        url: `/v1/opportunities/${adminId}/submitter`,
        headers: bearer(operatorToken),
      });
      expect(adminTransfer.statusCode, adminTransfer.body).toBe(200);
      expect(adminTransfer.json().source.submittedBy).toBe("m3claim-manager");
    } finally {
      await db
        .update(orgMemberships)
        .set({ role: "owner" })
        .where(
          and(
            eq(orgMemberships.accountId, operatorId),
            eq(orgMemberships.organizationId, operatorOrgId),
          ),
        );
    }
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

  it.each([true, false])(
    "an immediate grant settles only the actor's own pending request, same account: %s",
    async (sameAccount) => {
      const id = await seedEntry(`settle-${sameAccount}`, [HOST], []);
      const queued = await claim(sameAccount ? operatorToken : rivalToken, id, OPERATOR);
      expect(queued.statusCode, queued.body).toBe(202);
      await db
        .update(opportunities)
        .set({
          operatingOrganizations: [
            { name: HOST, slug: HOST },
            { name: OPERATOR, slug: OPERATOR },
          ],
        })
        .where(eq(opportunities.publicId, id));
      const granted = await claim(operatorToken, id, OPERATOR);
      expect(granted.statusCode, granted.body).toBe(200);
      expect(granted.json().claimId).toBe(sameAccount ? queued.json().claimId : null);
      const request = (
        await db
          .select()
          .from(opportunityClaims)
          .where(eq(opportunityClaims.id, queued.json().claimId))
      )[0];
      expect(request?.status).toBe(sameAccount ? "approved" : "pending");
      if (!sameAccount) {
        const rejected = await app.inject({
          method: "POST",
          url: `/v1/review/claims/${queued.json().claimId}/reject`,
          headers: bearer(reviewerToken),
        });
        expect(rejected.statusCode, rejected.body).toBe(200);
      }
    },
  );

  it("is idempotent when two colleagues file the same claim at the same instant", async () => {
    // The opportunity lock serializes both filings; colleagues receive the same organization claim.
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

  it("lets an account with no membership FILE a claim, which always queues", async () => {
    const id = await seedEntry("stranger-files", [HOST, OPERATOR], []);
    const res = await claim(strangerToken, id, OPERATOR);
    // OPERATOR is verified and operates the entry — a member would be granted here.
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe("queued");
    expect(res.json().message).toMatch(/not a member/);
  });

  it("adds the claimant as a member when a reviewer approves a stranger's claim", async () => {
    const id = await seedEntry("stranger-approved", [HOST], []);
    const queued = await claim(strangerToken, id, UNVERIFIED);
    expect(queued.statusCode).toBe(202);

    const decided = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: false },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().message).toMatch(/added as a member/);

    const memberships = await db
      .select()
      .from(orgMemberships)
      .where(eq(orgMemberships.accountId, strangerId));
    expect(memberships.map((m) => m.role)).toEqual(["publisher"]);
  });

  it("404s a claim on an organisation that does not exist", async () => {
    const id = await seedEntry("no-such-org");
    const res = await claim(strangerToken, id, "m3claim-does-not-exist");
    expect(res.statusCode).toBe(404);
  });

  it("caps the pending claims one account can have open", async () => {
    for (let i = 0; i < MAX_PENDING_CLAIMS_PER_ACCOUNT; i += 1) {
      const id = await seedEntry(`flood-${i}`, [HOST], []);
      expect((await claim(flooderToken, id, UNVERIFIED)).statusCode).toBe(202);
    }
    const over = await seedEntry("flood-over", [HOST], []);
    const res = await claim(flooderToken, over, UNVERIFIED);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("too_many_pending_claims");
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
    // The principal is resolved per request, so the pre-transaction membership check already sees
    // no membership here and queues instead of granting; the in-transaction re-check is what covers
    // a revocation that lands between the two.
    const res = await claim(operatorToken, id, OPERATOR);
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe("queued");
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

  it("refuses a READ-ONLY key even on the queue path, which used to be free", async () => {
    // The hole this closes: the `publish` bar above only fires when the claim would be GRANTED, so
    // a claim that merely queues had no scope check at all and a `read`-only key could file one.
    // Queueing is not nothing — it is a write on somebody else's entry with a reviewer decision in
    // flight behind it. SPONSOR only sponsors this entry, so this is unambiguously the queue path.
    const id = await seedEntry("queue-scope");
    const readOnly = await mintApiKeyFor(sponsorId, ["read"]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(readOnly),
      payload: { organizationSlug: SPONSOR },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("missing_scope");
    expect(res.json().message).toMatch(/`write` scope/);

    // …and nothing was filed. A 403 that still left a claim behind would be the worse bug.
    const entry = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    const rows = await db
      .select()
      .from(opportunityClaims)
      .where(eq(opportunityClaims.opportunityId, entry?.id ?? 0));
    expect(rows).toHaveLength(0);
  });

  it("queues for a `write` key — the queue path asks for `write`, not `publish`", async () => {
    // The other side of the bar: `write` is the whole requirement on the queue path. Raising it to
    // `publish` would stop an ordinary submission integration from asking a reviewer for anything.
    const id = await seedEntry("queue-scope-write");
    const key = await mintApiKeyFor(sponsorId, ["read", "write"]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/opportunities/${id}/claim`,
      headers: bearer(key),
      payload: { organizationSlug: SPONSOR },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().outcome).toBe("queued");
    expect(res.json().claimId).toEqual(expect.any(Number));

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.sourcePublisher).toBe(HOST);
  });

  it("directs an existing publisher member to management instead of accepting another claim", async () => {
    const id = await seedEntry("noop");
    await claim(operatorToken, id, OPERATOR);
    const again = await claim(operatorToken, id, OPERATOR);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_claimed");
    const access = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}/access`,
      headers: bearer(operatorToken),
    });
    expect(access.statusCode, access.body).toBe(200);
    expect(access.json()).toEqual({
      canViewManagement: true,
      canEdit: true,
      canAssumeSubmission: true,
      canAssignSubmission: false,
      canClaim: false,
    });
    const outsider = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}/access`,
      headers: bearer(rivalToken),
    });
    expect(outsider.json()).toEqual({
      canViewManagement: false,
      canEdit: false,
      canAssumeSubmission: false,
      canAssignSubmission: false,
      canClaim: false,
    });
    const request = await claim(rivalToken, id, OPERATOR);
    expect(request.statusCode, request.body).toBe(409);
    expect(request.json().error).toBe("already_claimed");
  });

  it("closes claims globally for account-owned and verified-publisher programs without any prior claim", async () => {
    for (const kind of ["account", "verified"] as const) {
      const id = await seedEntry(`owned-${kind}`);
      await db
        .update(opportunities)
        .set(kind === "account" ? { submittedBy: submitterId } : { sourcePublisher: OPERATOR })
        .where(eq(opportunities.publicId, id));
      const status = await app.inject({
        method: "GET",
        url: `/v1/opportunities/${id}/claim-status`,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().canClaim).toBe(false);
      for (const token of [operatorToken, rivalToken, colleagueToken, strangerToken]) {
        expect((await claim(token, id, OPERATOR)).statusCode).toBe(409);
      }
    }
  });

  it("closes claims after an approval even when the owning organization stays unverified", async () => {
    const id = await seedEntry("owned-unverified");
    const queued = await claim(unverifiedToken, id, UNVERIFIED);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: false },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}/claim-status` })).json()
        .canClaim,
    ).toBe(false);
    expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(409);
    expect((await claim(unverifiedToken, id, UNVERIFIED)).statusCode).toBe(409);
  });

  it.each([false, true])(
    "decides an existing claim after its opportunity returns to review, verified publisher: %s",
    async (verified) => {
      const id = await seedEntry(`review-again-${verified}`);
      const slug = verified ? SPONSOR : UNVERIFIED;
      const queued = await claim(verified ? sponsorToken : unverifiedToken, id, slug);
      expect(queued.statusCode, queued.body).toBe(202);
      await db
        .update(opportunities)
        .set({ reviewStatus: "pending", isListed: false })
        .where(eq(opportunities.publicId, id));
      expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(404);
      const decided = await app.inject({
        method: "POST",
        url: `/v1/review/claims/${queued.json().claimId}/approve`,
        headers: bearer(reviewerToken),
        payload: { verifyOrganization: false },
      });
      expect(decided.statusCode, decided.body).toBe(200);
      const row = (await db.select().from(opportunities).where(eq(opportunities.publicId, id)))[0];
      expect(row?.sourcePublisher).toBe(slug);
      expect(row?.reviewStatus).toBe(verified ? "approved" : "pending");
      expect(row?.isListed).toBe(false);
    },
  );

  it("refuses old pending approvals after another claim wins, while still allowing rejection", async () => {
    const id = await seedEntry("stale-approval");
    const queued = await claim(sponsorToken, id, SPONSOR);
    expect(queued.statusCode).toBe(202);
    expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(200);
    const decided = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: false },
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error).toBe("already_claimed");
    expect(
      (await db.select().from(opportunities).where(eq(opportunities.publicId, id)))[0]
        ?.sourcePublisher,
    ).toBe(OPERATOR);
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/reject`,
      headers: bearer(reviewerToken),
    });
    expect(rejected.statusCode).toBe(200);
  });

  it("does not expose private listings through the access endpoint", async () => {
    const id = await seedEntry("private-access");
    await db.update(opportunities).set({ isListed: false }).where(eq(opportunities.publicId, id));
    const response = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}/access`,
      headers: bearer(operatorToken),
    });
    expect(response.statusCode).toBe(404);
  });

  it("409s a claim against an entry a different VERIFIED organisation already publishes", async () => {
    const id = await seedEntry("taken", [HOST, OPERATOR, RIVAL], []);
    expect((await claim(operatorToken, id, OPERATOR)).statusCode).toBe(200);
    // RIVAL operates the entry too, and is verified — but OPERATOR already holds it.
    const res = await claim(rivalToken, id, RIVAL);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_claimed");
  });

  it("refuses to approve but allows rejecting a pending claim after its opportunity is merged", async () => {
    const survivorId = await seedEntry("claim-merge-survivor", [HOST], []);
    const loserId = await seedEntry("claim-merge-loser", [HOST], [SPONSOR]);
    const queued = await claim(sponsorToken, loserId, SPONSOR);
    expect(queued.statusCode, queued.body).toBe(202);

    const claimQueue = await app.inject({
      method: "GET",
      url: "/v1/review/claims?status=pending",
      headers: bearer(reviewerToken),
    });
    const queuedClaim = claimQueue
      .json()
      .items.find((item: { id: number }) => item.id === queued.json().claimId);
    expect(queuedClaim.claimedByAccountId).toBe(sponsorId);

    const entries = await db
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(or(eq(opportunities.publicId, survivorId), eq(opportunities.publicId, loserId)));
    const ids = new Map(entries.map((entry) => [entry.publicId, entry.id]));
    const low = Math.min(ids.get(survivorId) as number, ids.get(loserId) as number);
    const high = Math.max(ids.get(survivorId) as number, ids.get(loserId) as number);
    const existing = await db
      .select({ id: opportunityDuplicates.id })
      .from(opportunityDuplicates)
      .where(
        or(
          and(
            eq(opportunityDuplicates.opportunityId, low),
            eq(opportunityDuplicates.duplicateOfId, high),
          ),
          and(
            eq(opportunityDuplicates.opportunityId, high),
            eq(opportunityDuplicates.duplicateOfId, low),
          ),
        ),
      )
      .limit(1);
    const pair =
      existing[0] ??
      (
        await db
          .insert(opportunityDuplicates)
          .values({ opportunityId: low, duplicateOfId: high, similarity: "0.99" })
          .returning({ id: opportunityDuplicates.id })
      )[0];
    expect(pair).toBeDefined();

    const merged = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pair?.id}/merge`,
      headers: bearer(reviewerToken),
      payload: { survivorId },
    });
    expect(merged.statusCode, merged.body).toBe(200);

    const before = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, loserId)).limit(1)
    )[0];
    expect(before?.mergedIntoId).toBe(ids.get(survivorId));

    const approval = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/approve`,
      headers: bearer(reviewerToken),
      payload: { verifyOrganization: false },
    });
    expect(approval.statusCode, approval.body).toBe(409);
    expect(approval.json().error).toBe("opportunity_merged");

    const after = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, loserId)).limit(1)
    )[0];
    expect(after).toEqual(before);
    const pendingClaim = (
      await db
        .select({ status: opportunityClaims.status })
        .from(opportunityClaims)
        .where(eq(opportunityClaims.id, queued.json().claimId))
        .limit(1)
    )[0];
    expect(pendingClaim?.status).toBe("pending");

    const rejection = await app.inject({
      method: "POST",
      url: `/v1/review/claims/${queued.json().claimId}/reject`,
      headers: bearer(reviewerToken),
    });
    expect(rejection.statusCode, rejection.body).toBe(200);
    expect(rejection.json()).toMatchObject({
      outcome: "unchanged",
      claimId: queued.json().claimId,
      opportunityId: loserId,
      organizationSlug: SPONSOR,
    });

    const queue = await app.inject({
      method: "GET",
      url: "/v1/review/claims?status=pending",
      headers: bearer(reviewerToken),
    });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json().items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: queued.json().claimId })]),
    );

    const rejectedClaim = (
      await db
        .select({ status: opportunityClaims.status })
        .from(opportunityClaims)
        .where(eq(opportunityClaims.id, queued.json().claimId))
        .limit(1)
    )[0];
    expect(rejectedClaim?.status).toBe("rejected");
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

  /**
   * Submit an entry into the unverified `HOST` namespace, then move ownership of it to `CLAIMED`
   * through a reviewer-approved claim. The entry ends up with `submitted_by = <the submitter>` and
   * `source_publisher = CLAIMED`, which is the exact shape the write rule is about.
   */
  async function submitThenHandOver(localId: string, token: string) {
    const id = `${HOST}:${localId}`;
    const filed = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: submission(id, HOST, {
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: CLAIMED, slug: CLAIMED },
        ],
      } as Record<string, unknown>),
    });
    expect(filed.statusCode, filed.body).toBe(201);

    // A claim may only be filed against a PUBLIC entry — answering about a pending one would be an
    // existence oracle over the review queue — so the submission goes through review first. The
    // approval is a review decision and leaves `submitted_by` alone, which is the point.
    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${id}/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // Recreate a legacy granted transfer. New claims on account-owned programs are now forbidden.
    const original = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id))
    )[0];
    if (!original) throw new Error("missing historical submission");
    await db
      .update(opportunities)
      .set({ sourcePublisher: CLAIMED })
      .where(eq(opportunities.id, original.id));
    await db.insert(auditLog).values({
      subjectKind: "opportunity",
      subjectId: original.id,
      action: "grant_publisher",
      actorKind: "user",
      patch: { organizationSlug: CLAIMED },
    });

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.sourcePublisher).toBe(CLAIMED);
    return id;
  }

  const replace = (token: string, id: string, title: string) =>
    app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(token),
      payload: submission(id, HOST, {
        title,
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: CLAIMED, slug: CLAIMED },
        ],
      } as Record<string, unknown>),
    });

  it("takes PUT away from the original submitter once a claim has moved ownership", async () => {
    // `submitted_by` is a historical fact about who typed the entry in, not a standing authority
    // over it — and it does not move when a claim is granted. So an aggregator that filed the entry
    // used to keep PUT on it forever, editing something now published in the claimant's name.
    const id = await submitThenHandOver("submitter-loses-put", submitterToken);

    const access = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}/access`,
      headers: bearer(submitterToken),
    });
    expect(access.json()).toEqual({
      canViewManagement: true,
      canEdit: false,
      canAssumeSubmission: false,
      canAssignSubmission: false,
      canClaim: false,
    });
    const reviewerAccess = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${id}/access`,
      headers: bearer(reviewerToken),
    });
    expect(reviewerAccess.json()).toEqual({
      canViewManagement: true,
      canEdit: true,
      canAssumeSubmission: false,
      canAssignSubmission: false,
      canClaim: false,
    });

    const res = await replace(submitterToken, id, "Edited by the former owner");
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_your_entry");
    // "submitted by another account" would be actively wrong here — they DID submit it.
    expect(res.json().message).toMatch(/ownership has since moved/);
    expect(res.json().message).toContain(CLAIMED);

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.title).not.toBe("Edited by the former owner");

    // …and the entry is not frozen, it has simply changed hands: a Hub reviewer still corrects it
    // on the T3 arm, and that write is EDITORIAL — the same submitter exemption that no longer
    // covers the former owner no longer exempts a reviewer who happens to have filed something,
    // which is why the two functions share one definition of "mine".
    const editorial = await replace(reviewerToken, id, "Corrected by a reviewer");
    expect(editorial.statusCode, editorial.body).toBe(200);
    expect(editorial.json().opportunity.title).toBe("Corrected by a reviewer");
  });

  it("keeps PUT for a submitter who is a member of the organisation that claimed it", async () => {
    // THE COMMON CASE, and the reason the test is membership rather than VERIFIED membership:
    // somebody submits on their organisation's behalf, the organisation then claims the entry, and
    // they must not lose write access to their own work over a change they asked for. `CLAIMED` is
    // deliberately unverified here, so the T2 arm cannot be what carries this — only the submitter
    // arm can.
    const id = await submitThenHandOver("member-keeps-put", insiderToken);

    const res = await replace(insiderToken, id, "Still mine after the claim");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunity.title).toBe("Still mine after the claim");
  });

  it("does not restore the submitter's PUT when the entry is claimed BACK to its own namespace", async () => {
    // THE REASON THIS RULE CANNOT BE INFERRED FROM THE ID. An entry claimed away and then claimed
    // back converges again — publisher equals the id prefix, exactly as it did on the day it was
    // filed — while ownership has genuinely changed hands twice and now belongs to `HOST` rather
    // than to whoever typed it in. Anything that reads the id instead of the record of the
    // transfers hands PUT straight back to the former owner here.
    const id = `${HOST}:reclaimed`;
    const filed = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, HOST, {
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: OPERATOR, slug: OPERATOR },
        ],
      } as Record<string, unknown>),
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const published = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${id}/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(200);

    // Legacy round-trip grants remain durable ownership markers; the current claim API forbids them.
    const original = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id))
    )[0];
    if (!original) throw new Error("missing historical submission");
    for (const slug of [OPERATOR, HOST])
      await db.insert(auditLog).values({
        subjectKind: "opportunity",
        subjectId: original.id,
        action: "grant_publisher",
        actorKind: "user",
        patch: { organizationSlug: slug },
      });

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    // The publisher now agrees with the id prefix again — and means nothing by it.
    expect(row?.sourcePublisher).toBe(HOST);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(submitterToken),
      payload: submission(id, HOST, {
        title: "Edited by the account that filed it",
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: OPERATOR, slug: OPERATOR },
        ],
      } as Record<string, unknown>),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_your_entry");
    // A claim really did take it, twice, so the claim sentence is the honest one here.
    expect(res.json().message).toMatch(/ownership has since moved/);

    // Not frozen, just not theirs: a reviewer still corrects it. (A member of `HOST` cannot,
    // because `HOST` is unverified and the namespace arm wants a VERIFIED membership — existing
    // behaviour of the T2 arm, unrelated to the claim rule under test.)
    const editorial = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(reviewerToken),
      payload: submission(id, HOST, {
        title: "Corrected after the round trip",
        operatingOrganizations: [
          { name: HOST, slug: HOST },
          { name: OPERATOR, slug: OPERATOR },
        ],
      } as Record<string, unknown>),
    });
    expect(editorial.statusCode, editorial.body).toBe(200);
  });

  it("leaves a LEGACY divergent row editable by its submitter — divergence is not a claim", async () => {
    // The corpus shape: `fundingmap:1042` is published under `optimism` and always was, with no
    // claim anywhere in its history (see legacy-publisher-edit.test.ts). Treating publisher ≠ id
    // prefix as evidence of a transfer locks the submitter of a row like this out of ordinary
    // corrections AND tells them a claim took it, which never happened.
    const id = "m3claim-aggregator:1042";
    await ingest.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: "Legacy divergent",
        description: "Published under a namespace its id does not name.",
        status: "open",
        operatingOrganizations: [{ name: LEGACY_PUB, slug: LEGACY_PUB }],
        source: { publisher: LEGACY_PUB, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3CLAIM"],
        fundingDetails: { fundingType: "grant" },
      },
      { reviewStatus: "approved", isListed: true, sourceSystem: LEGACY_PUB },
    );
    // The one thing the ingest path does not set, and the only reason this row is interesting: a
    // human account owns it.
    await db
      .update(opportunities)
      .set({ submittedBy: submitterId })
      .where(eq(opportunities.publicId, id));

    const res = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(submitterToken),
      payload: submission(id, LEGACY_PUB, {
        title: "Corrected by the account that filed it",
        operatingOrganizations: [{ name: LEGACY_PUB, slug: LEGACY_PUB }],
      } as Record<string, unknown>),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunity.title).toBe("Corrected by the account that filed it");
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

    const verifiedEmails = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, unverifiedId),
          eq(notifications.kind, "publisher_verified"),
        ),
      );
    expect(verifiedEmails).toHaveLength(1);

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
