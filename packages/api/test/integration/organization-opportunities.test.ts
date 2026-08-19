import { eq } from "drizzle-orm";
/**
 * `GET /v1/organizations/:slug/opportunities` — an organisation's own view of what it has published,
 * including the entries the public reads are pinned away from.
 *
 * TWO RULES CARRY THIS ENDPOINT, and both are negatives:
 *
 *   1. **Membership, of any kind.** Verification decides whether a write lands approved; it has
 *      nothing to say about who may look. A member of an unverified organisation still needs to see
 *      what their colleagues submitted.
 *   2. **`source.publisher`, never the sponsor union.** `org_slugs` includes SPONSORS, and matching
 *      on it would show one organisation's unpublished queue to another that merely funds a
 *      programme. That is the case this file exists to pin.
 *
 * Isolation tag: `M3ORGOPP` / `m3orgopp*`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  seedIdentity,
  seedOrganization,
  testAuth,
  testAuthConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { describeWithDb } from "./db-gate.js";

/** The organisation under test: it PUBLISHES. */
const HOME = "m3orgopp-home";
/** Present on the same entries as a SPONSOR only. Must see nothing. */
const SPONSOR = "m3orgopp-sponsor";
/** Unverified, and a member of it must still see its queue. */
const UNVERIFIED = "m3orgopp-unverified";

const EMAILS = {
  member: "m3orgopp-member@rfphub.invalid",
  sponsor: "m3orgopp-sponsor@rfphub.invalid",
  stranger: "m3orgopp-stranger@rfphub.invalid",
  /** A verified member of HOME who is ALSO Hub staff — the dual-role case. */
  staff: "m3orgopp-staff@rfphub.invalid",
  unverified: "m3orgopp-unverified@rfphub.invalid",
};
const HANDLES = [
  "m3orgopp-member",
  "m3orgopp-sponsor-h",
  "m3orgopp-stranger",
  "m3orgopp-unv",
  "m3orgopp-staff",
];

/**
 * Public reads in this file carry `DNT: 1`.
 *
 * They are asserting VISIBILITY — "is this entry served to the world" — and nothing about
 * analytics. Without the header each one also captures a detail view into the analytics buffer,
 * which is a module-level singleton shared by every app in the worker process, and the shutdown
 * suite asserts that buffer's ABSOLUTE depth. Two suites in one worker then fail each other for
 * reasons neither is about. Opting out costs this file nothing: the request is still an
 * unauthenticated GET and still answers 200 or 404, which is the whole assertion.
 */
const PUBLIC_READ = { dnt: "1" } as const;

const run = describeWithDb;
const ingest = new OpportunityService();

run("M3ORGOPP an organisation's own entries", () => {
  let app: FastifyInstance;
  let memberToken: string;
  let memberKey: string;
  let memberAccountId: number;
  let sponsorToken: string;
  let strangerToken: string;
  let unverifiedToken: string;
  let staffMemberToken: string;
  const userIds: string[] = [];

  /** One entry published under `HOME`, sponsored by `SPONSOR`, at a chosen review status. */
  async function seedEntry(
    localId: string,
    reviewStatus: "pending" | "approved" | "rejected",
    publisher = HOME,
  ) {
    const id = `${publisher}:${localId}`;
    await ingest.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id,
        fundingType: "grant",
        title: `Entry ${localId}`,
        description: "An entry.",
        status: "open",
        operatingOrganizations: [{ name: publisher, slug: publisher }],
        sponsoringOrganizations: [{ name: SPONSOR, slug: SPONSOR }],
        source: { publisher, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3ORGOPP"],
        fundingDetails: { fundingType: "grant" },
      },
      // Listed unless rejected — the shape the write path really produces: a submission arrives
      // listed and pending, and only a reviewer's unlisting or a rejection clears the flag. Seeding
      // pending rows unlisted would have made "approving preserves the listing" trivially true.
      { reviewStatus, isListed: reviewStatus !== "rejected", sourceSystem: publisher },
    );
    return id;
  }

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
    await cleanupFixtures({ handles: HANDLES, emails: Object.values(EMAILS) });

    const home = await seedOrganization({ slug: HOME, verified: true });
    const sponsor = await seedOrganization({ slug: SPONSOR, verified: true });
    const unverified = await seedOrganization({ slug: UNVERIFIED, verified: false });

    const member = await seedIdentity(EMAILS.member, { handle: "m3orgopp-member" });
    const sponsorMember = await seedIdentity(EMAILS.sponsor, { handle: "m3orgopp-sponsor-h" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3orgopp-stranger" });
    const unverifiedMember = await seedIdentity(EMAILS.unverified, { handle: "m3orgopp-unv" });
    const staffMember = await seedIdentity(EMAILS.staff, {
      handle: "m3orgopp-staff",
      role: "admin",
    });
    userIds.push(
      member.userId,
      sponsorMember.userId,
      stranger.userId,
      unverifiedMember.userId,
      staffMember.userId,
    );

    await grantMembership(member.account.id, home.id);
    await grantMembership(sponsorMember.account.id, sponsor.id);
    await grantMembership(unverifiedMember.account.id, unverified.id);
    await grantMembership(staffMember.account.id, home.id);

    memberToken = member.token;
    memberAccountId = member.account.id;
    memberKey = await mintApiKeyFor(member.account.id, ["read"]);
    sponsorToken = sponsorMember.token;
    strangerToken = stranger.token;
    unverifiedToken = unverifiedMember.token;
    staffMemberToken = staffMember.token;

    // Submitted by NOBODY in particular — the point is that a member sees a colleague's work, not
    // only their own, which is what `/v1/me/opportunities` already covers.
    await seedEntry("pending-one", "pending");
    await seedEntry("approved-one", "approved");
    await seedEntry("rejected-one", "rejected");
    await seedEntry("elsewhere", "pending", UNVERIFIED);
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3orgopp",
      organizationSlugs: [HOME, SPONSOR, UNVERIFIED],
      handles: HANDLES,
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  }, 60_000);

  const list = async (slug: string, token: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/v1/organizations/${slug}/opportunities${query}`,
      headers: bearer(token),
    });

  it("shows a member everything filed under the namespace, including a colleague's pending entry", async () => {
    const res = await list(HOME, memberToken);
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json().items.map((item: { id: string }) => item.id);
    expect(ids).toContain(`${HOME}:pending-one`);
    expect(ids).toContain(`${HOME}:approved-one`);
    expect(ids).toContain(`${HOME}:rejected-one`);
    // The envelope is the one `/v1/me/opportunities` uses, field for field.
    expect(res.json()).toMatchObject({ page: 1, limit: 20 });
    expect(typeof res.json().total).toBe("number");
    expect(typeof res.json().totalPages).toBe("number");
  }, 60_000);

  it("shows a SPONSOR nothing, which is the whole reason the predicate is `source.publisher`", async () => {
    // The sponsor's slug is on every one of those entries — in `org_slugs`, in
    // `sponsoringOrganizations`, and in the public filters. None of that is publication, and a
    // union-based predicate would have handed this organisation its funder's unpublished queue.
    const res = await list(SPONSOR, sponsorToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().total).toBe(0);
  }, 60_000);

  it("serves a member of an UNVERIFIED organisation — verification governs publishing, not looking", async () => {
    const res = await list(UNVERIFIED, unverifiedToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toContain(
      `${UNVERIFIED}:elsewhere`,
    );
  }, 60_000);

  it("403s an account with no membership, and 404s a slug that does not exist", async () => {
    const outsider = await list(HOME, strangerToken);
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toBe("not_a_member");

    // A member of one organisation is an outsider to the next.
    const wrongOrg = await list(HOME, sponsorToken);
    expect(wrongOrg.statusCode).toBe(403);

    const missing = await list("m3orgopp-nonexistent", memberToken);
    expect(missing.statusCode).toBe(404);
    // The unknown slug is answered BEFORE the membership check: organisations are a public
    // directory, so their existence is not the secret — the queue is.
    expect(missing.json().error).toBe("not_found");
  }, 60_000);

  it("401s without a credential, and serves an API key that belongs to a member", async () => {
    const anonymous = await app.inject({
      method: "GET",
      url: `/v1/organizations/${HOME}/opportunities`,
    });
    expect(anonymous.statusCode).toBe(401);

    // Either credential kind: an organisation's dashboard is exactly what a key is for, and the
    // membership check is what decides — not the shape of the credential.
    const byKey = await list(HOME, memberKey);
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(byKey.json().items.length).toBeGreaterThan(0);
  }, 60_000);

  // ── approving one's own queue ──────────────────────────────────────────────────
  const approve = async (slug: string, id: string, token: string) =>
    app.inject({
      method: "POST",
      url: `/v1/organizations/${slug}/opportunities/${id}/approve`,
      headers: bearer(token),
    });

  const rowFor = async (publicId: string) =>
    (await db.select().from(opportunities).where(eq(opportunities.publicId, publicId)).limit(1))[0];

  it("lets a verified member publish their organisation's own pending entry", async () => {
    const id = await seedEntry("member-approves", "pending");
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}`, headers: PUBLIC_READ }))
        .statusCode,
    ).toBe(404);

    const decided = await approve(HOME, id, memberToken);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ id, reviewStatus: "approved", isListed: true });
    // Published to the world, which is the whole consequence and the reason the gate is VERIFIED
    // membership rather than any membership.
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}`, headers: PUBLIC_READ }))
        .statusCode,
    ).toBe(200);

    const stored = await rowFor(id);
    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, stored?.id ?? 0))
      .orderBy(auditLog.id);
    const approval = trail.filter((r) => r.action === "approve").at(-1);
    // A DISTINCT REASON, so the trail tells the three kinds of approval apart: a Hub reviewer's, the
    // write path's automatic one, and a publisher releasing their own entry.
    expect((approval?.patch as { reason?: string })?.reason).toBe("operating_org_approval");
    expect(approval?.actorAccountId).toBe(memberAccountId);

    // ATTRIBUTED BY NAME, on purpose. The public trail coarsens an EDITORIAL action to "reviewer"
    // because a reader must not be able to go and argue with the individual who rejected them;
    // this is not that. It is a publisher publishing their own organisation's entry, and the
    // organisation is accountable for it — so the handle is the right answer, and the role snapshot
    // says `submitter` because that is what this person is.
    const publicTrail = await app.inject({ method: "GET", url: `/v1/opportunities/${id}/audit` });
    expect(publicTrail.statusCode).toBe(200);
    const publicApproval = (publicTrail.json().entries as { action: string; actor: string }[]).find(
      (entry) => entry.action === "approve",
    );
    expect(publicApproval?.actor).toBe("m3orgopp-member");
    expect(approval?.actorRole).toBe("submitter");
  }, 60_000);

  it("refuses an unverified organisation's member, an outsider, and a second approval", async () => {
    // Unverified: allowed to LOOK (asserted above), not to publish. Verification is the trust event
    // auto-publish rides on, and this rides the same one.
    const inUnverified = await seedEntry("unverified-approve", "pending", UNVERIFIED);
    const refused = await approve(UNVERIFIED, inUnverified, unverifiedToken);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe("not_a_verified_member");
    expect((await rowFor(inUnverified))?.reviewStatus).toBe("pending");

    // A VERIFIED member of another organisation, pointed at this one's entry. 404, not 403: a 403
    // would confirm the entry exists and turn this route into a way to enumerate other
    // organisations' pending queues.
    const target = await seedEntry("wrong-org", "pending");
    const crossOrg = await approve(SPONSOR, target, sponsorToken);
    expect(crossOrg.statusCode).toBe(404);
    // …and the same entry addressed through ITS OWN namespace by that outsider is a 403 at the
    // membership gate, which is the other half of the pair.
    expect((await approve(HOME, target, sponsorToken)).statusCode).toBe(403);
    expect((await rowFor(target))?.reviewStatus).toBe("pending");

    // Already decided: not an error to retry into, but not a silent success either.
    const once = await approve(HOME, target, memberToken);
    expect(once.statusCode, once.body).toBe(200);
    const twice = await approve(HOME, target, memberToken);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("not_pending");
    expect(twice.json().message).toContain("approved");
  }, 60_000);

  it("refuses an API key, however scoped — approving is session-only", async () => {
    const id = await seedEntry("by-key", "pending");
    const res = await approve(HOME, id, memberKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("session_required");
    expect((await rowFor(id))?.reviewStatus).toBe("pending");
  }, 60_000);

  it("fails closed when the organisation is un-verified while the approval is in flight", async () => {
    // THE REVOCATION RACE, scheduled rather than hoped for. Memberships and verification are
    // resolved when the bearer is exchanged, and a request can outlive that answer — so the
    // authority is read again inside the approving transaction, under the entry's lock. A reviewer
    // withdrawing verification mid-flight must not be beaten by an approval that is already past
    // its own gate.
    const id = await seedEntry("racing-unverify", "pending");
    const barrier = await openLockBarrier();
    let decided: Awaited<ReturnType<typeof approve>>;
    try {
      // Uncommitted: the organisation row is locked by the barrier, not yet un-verified.
      await barrier.run("update organizations set verified = false where slug = $1", [HOME]);
      const pending = approve(HOME, id, memberToken);
      // The approval can only block here because it re-proves the authority under lock. A path that
      // trusted the request's principal would never touch this row, so the wait IS the assertion.
      await barrier.waitForWaiters(1);
      await barrier.commit();
      decided = await pending;
    } finally {
      await barrier.rollback();
      await db.update(organizations).set({ verified: true }).where(eq(organizations.slug, HOME));
    }

    expect(decided.statusCode, decided.body).toBe(403);
    expect(decided.json().error).toBe("not_a_verified_member");
    // …and the entry is still pending, which is the half that matters.
    expect((await rowFor(id))?.reviewStatus).toBe("pending");
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}`, headers: PUBLIC_READ }))
        .statusCode,
    ).toBe(404);
  }, 60_000);

  it("does not republish an entry a reviewer had unlisted — approving is not a listing decision", async () => {
    // THE SILENT REPUBLISH THIS CLOSES. Approval and listing are separate decisions, and the staff
    // route has always kept them apart. Forcing `is_listed` true here would undo a reviewer's
    // deliberate unlisting — or resurrect a rejected-then-edited row — by somebody who never saw
    // that decision and is not told they are overriding it.
    const id = await seedEntry("unlisted-pending", "pending");
    await db.update(opportunities).set({ isListed: false }).where(eq(opportunities.publicId, id));

    const decided = await approve(HOME, id, memberToken);
    expect(decided.statusCode, decided.body).toBe(200);
    // Approved, and still unlisted: the reviewer's decision survives the publisher's.
    expect(decided.json()).toMatchObject({ reviewStatus: "approved", isListed: false });
    const stored = await rowFor(id);
    expect(stored?.reviewStatus).toBe("approved");
    expect(stored?.isListed).toBe(false);
    // …so it stays out of the public reads, which is what the unlisting was for.
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}`, headers: PUBLIC_READ }))
        .statusCode,
    ).toBe(404);

    // And the trail does not claim a listing change that did not happen.
    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, stored?.id ?? 0))
      .orderBy(auditLog.id);
    const approval = trail.filter((r) => r.action === "approve").at(-1);
    expect(Object.keys(approval?.patch ?? {})).not.toContain("isListed");
  }, 60_000);

  // ── refusing, with a reason ────────────────────────────────────────────────────
  const reject = async (slug: string, id: string, token: string, reason?: string) =>
    app.inject({
      method: "POST",
      url: `/v1/organizations/${slug}/opportunities/${id}/reject`,
      headers: bearer(token),
      payload: reason === undefined ? {} : { reason },
    });

  it("lets a verified member refuse an entry in their namespace, and records WHO and WHY", async () => {
    const id = await seedEntry("member-rejects", "pending");
    const decided = await reject(HOME, id, memberToken, "this programme closed in 2024");
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ id, reviewStatus: "rejected", isListed: false });
    // Rejection unlists as well as un-approves — two flags that disagree are how a later query gets
    // it wrong.
    expect(
      (await app.inject({ method: "GET", url: `/v1/opportunities/${id}`, headers: PUBLIC_READ }))
        .statusCode,
    ).toBe(404);

    const stored = await rowFor(id);
    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, stored?.id ?? 0))
      .orderBy(auditLog.id);
    const refusal = trail.filter((r) => r.action === "reject").at(-1);
    const patch = refusal?.patch as { reason?: string; via?: string };
    expect(patch?.reason).toBe("this programme closed in 2024");
    // The machine-readable half: the trail must tell a publisher's decision from a Hub reviewer's
    // for BOTH verbs, and `reason` cannot carry that once it is holding somebody's sentence.
    expect(patch?.via).toBe("operating_org");
    expect(refusal?.actorAccountId).toBe(memberAccountId);

    // ACCOUNTABILITY IS THE COUNTERWEIGHT. An organisation refusing a third party's account of its
    // own programme is the decision that most needs a name against it, so this one is NOT coarsened
    // to "reviewer" the way a Hub reviewer's is.
    //
    // Read WITH a credential: a rejected entry is not public, so its trail 404s for a stranger —
    // the same rule the detail route follows, and not something this assertion should route around.
    const trailView = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${id}/audit`,
      headers: bearer(memberToken),
    });
    expect(trailView.statusCode, trailView.body).toBe(200);
    const shownRefusal = (trailView.json().entries as { action: string; actor: string }[]).find(
      (entry) => entry.action === "reject",
    );
    expect(shownRefusal?.actor).toBe("m3orgopp-member");
  }, 60_000);

  it("shows the submitter the reason on their own listing", async () => {
    // The other half of accountability: a reason recorded where the person it concerns cannot read
    // it would be a formality. `lastDecision` is what carries it back.
    const id = await seedEntry("rejected-visible", "pending");
    await reject(HOME, id, memberToken, "duplicated by an entry we already publish");

    const mine = await app.inject({
      method: "GET",
      url: `/v1/organizations/${HOME}/opportunities?limit=100`,
      headers: bearer(memberToken),
    });
    const entry = (
      mine.json().items as { id: string; lastDecision: { action: string; reason: string } | null }[]
    ).find((item) => item.id === id);
    expect(entry?.lastDecision).toMatchObject({
      action: "reject",
      reason: "duplicated by an entry we already publish",
    });
  }, 60_000);

  it("refuses a rejection with no reason, and applies approve's guards to reject as well", async () => {
    const id = await seedEntry("reject-guards", "pending");

    // A reason is not optional — that is what makes the decision answerable for itself.
    for (const missing of [undefined, "", "   "]) {
      const res = await reject(HOME, id, memberToken, missing);
      expect(res.statusCode, `reason=${JSON.stringify(missing)}`).toBe(400);
      expect(["reason_required", "bad_request"]).toContain(res.json().error);
    }
    expect((await rowFor(id))?.reviewStatus).toBe("pending");

    // The guards are approve's, verbatim: unverified member, outsider, other namespace, API key.
    const inUnverified = await seedEntry("reject-unverified", "pending", UNVERIFIED);
    expect((await reject(UNVERIFIED, inUnverified, unverifiedToken, "no")).statusCode).toBe(403);
    expect((await reject(SPONSOR, id, sponsorToken, "no")).statusCode).toBe(404);
    expect((await reject(HOME, id, sponsorToken, "no")).statusCode).toBe(403);
    expect((await reject(HOME, id, memberKey, "no")).statusCode).toBe(403);

    // …and a decided entry cannot be re-decided.
    expect((await reject(HOME, id, memberToken, "out of scope")).statusCode).toBe(200);
    const again = await reject(HOME, id, memberToken, "still out of scope");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_pending");
  }, 60_000);

  it("fails a rejection closed when the organisation is un-verified mid-flight", async () => {
    const id = await seedEntry("racing-reject", "pending");
    const barrier = await openLockBarrier();
    let decided: Awaited<ReturnType<typeof reject>>;
    try {
      await barrier.run("update organizations set verified = false where slug = $1", [HOME]);
      const pending = reject(HOME, id, memberToken, "spam");
      // Blocks only because the authority is re-proved under the entry's lock — the same doctrine
      // the approve route and the write path follow.
      await barrier.waitForWaiters(1);
      await barrier.commit();
      decided = await pending;
    } finally {
      await barrier.rollback();
      await db.update(organizations).set({ verified: true }).where(eq(organizations.slug, HOME));
    }
    expect(decided.statusCode, decided.body).toBe(403);
    expect(decided.json().error).toBe("not_a_verified_member");
    expect((await rowFor(id))?.reviewStatus).toBe("pending");
  }, 60_000);

  it("names a dual-role member by handle here, and still anonymises them on the STAFF route", async () => {
    // THE ANONYMITY THIS KEEPS POINTED THE RIGHT WAY. The public trail coarsens a reviewer or admin
    // to "reviewer" so nobody can go and argue with the individual who rejected them. A member who
    // ALSO happens to be Hub staff, deciding about their own organisation's queue, is not that
    // case: they are the interested party, and the by-handle accountability this route promises is
    // the whole counterweight to letting them decide at all. So the label follows the CAPACITY the
    // decision was taken in, not whatever global role the person happens to hold.
    const viaOrg = await seedEntry("dual-role-org", "pending");
    const viaStaff = await seedEntry("dual-role-staff", "pending");

    const decidedHere = await reject(
      HOME,
      viaOrg,
      staffMemberToken,
      "we do not run this programme",
    );
    expect(decidedHere.statusCode, decidedHere.body).toBe(200);

    // The SAME person, the same verb, through the Hub's own review route.
    const decidedThere = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${viaStaff}/reject`,
      headers: bearer(staffMemberToken),
      payload: { reason: "out of scope for the Hub" },
    });
    expect(decidedThere.statusCode, decidedThere.body).toBe(200);

    const actorFor = async (publicId: string) => {
      const trail = await app.inject({
        method: "GET",
        url: `/v1/opportunities/${publicId}/audit`,
        headers: bearer(staffMemberToken),
      });
      expect(trail.statusCode, trail.body).toBe(200);
      return (trail.json().entries as { action: string; actor: string }[]).find(
        (entry) => entry.action === "reject",
      )?.actor;
    };

    expect(await actorFor(viaOrg)).toBe("m3orgopp-staff");
    // …and the staff route is untouched: there they really are acting as a reviewer.
    expect(await actorFor(viaStaff)).toBe("reviewer");
  }, 60_000);

  it("filters by review status and paginates", async () => {
    const pending = await list(HOME, memberToken, "?reviewStatus=pending");
    expect(pending.statusCode).toBe(200);
    const statuses = pending.json().items.map((i: { reviewStatus: string }) => i.reviewStatus);
    expect(new Set(statuses)).toEqual(new Set(["pending"]));

    const firstPage = await list(HOME, memberToken, "?limit=1&page=1");
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().limit).toBe(1);
    expect(firstPage.json().totalPages).toBeGreaterThan(1);

    const secondPage = await list(HOME, memberToken, "?limit=1&page=2");
    expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
  }, 60_000);
});
