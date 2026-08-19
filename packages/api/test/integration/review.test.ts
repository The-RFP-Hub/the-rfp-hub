/**
 * The review and admin surfaces: queue visibility, approve/reject effects, the organisation
 * verification that flips a whole namespace, membership revocation that takes it back, and the
 * public publisher list.
 *
 * Isolation tag: `M3REV` / `m3rev:`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, orgMemberships } from "../../src/db/schema.js";
import {
  bearer,
  grantMembership,
  seedAccount,
  seedIdentity,
  seedOrganization,
  signIn,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3rev";
const CANDIDATE = "m3rev-candidate";
const EMAILS = {
  submitter: "m3rev-submitter@rfphub.invalid",
  member: "m3rev-member@rfphub.invalid",
  reviewer: "m3rev-reviewer@rfphub.invalid",
  admin: "m3rev-admin@rfphub.invalid",
  raceMember: "m3rev-race-member@rfphub.invalid",
};

const run = describeWithDb;

run("M3REV review and administration", () => {
  let app: FastifyInstance;
  let submitterToken: string;
  let memberToken: string;
  let reviewerToken: string;
  let adminToken: string;
  let memberId: number;
  let candidateOrgId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m3rev-submitter" });
    const member = await seedIdentity(EMAILS.member, { handle: "m3rev-member" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3rev-reviewer",
      role: "reviewer",
    });
    const admin = await seedIdentity(EMAILS.admin, { handle: "m3rev-admin", role: "admin" });
    memberId = member.account.id;
    userIds.push(submitter.userId, member.userId, reviewer.userId, admin.userId);

    await seedOrganization({ slug: NS, verified: false });
    const candidate = await seedOrganization({ slug: CANDIDATE, verified: false });
    candidateOrgId = candidate.id;
    await grantMembership(member.account.id, candidate.id, "owner");

    submitterToken = submitter.token;
    memberToken = member.token;
    reviewerToken = reviewer.token;
    adminToken = admin.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3rev",
      organizationSlugs: [NS, CANDIDATE],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  it("shows a pending submission in the queue and 403s a non-reviewer", async () => {
    const id = `${NS}:queued`;
    await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(id, NS),
    });

    const denied = await app.inject({
      method: "GET",
      url: "/v1/review/opportunities",
      headers: bearer(submitterToken),
    });
    expect(denied.statusCode).toBe(403);

    const queue = await app.inject({
      method: "GET",
      url: "/v1/review/opportunities",
      headers: bearer(reviewerToken),
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it("makes an approved entry public and a rejected one both unlisted and invisible", async () => {
    const approvedId = `${NS}:to-approve`;
    const rejectedId = `${NS}:to-reject`;
    for (const id of [approvedId, rejectedId]) {
      await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: bearer(submitterToken),
        payload: submission(id, NS),
      });
    }

    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${approvedId}/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().reviewStatus).toBe("approved");
    expect((await app.inject({ url: `/v1/opportunities/${approvedId}` })).statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${rejectedId}/reject`,
      headers: bearer(reviewerToken),
      payload: { reason: "out of scope" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().reviewStatus).toBe("rejected");
    // Rejection also unlists: leaving `is_listed` true would record a listing intent that is no
    // longer true, and two flags that disagree are how a later query gets it wrong.
    expect(rejected.json().isListed).toBe(false);
    expect((await app.inject({ url: `/v1/opportunities/${rejectedId}` })).statusCode).toBe(404);
  });

  it("unlists and relists an approved entry", async () => {
    const id = `${NS}:to-approve`;
    const unlisted = await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${id}`,
      headers: bearer(reviewerToken),
      payload: { isListed: false },
    });
    expect(unlisted.json().isListed).toBe(false);
    expect((await app.inject({ url: `/v1/opportunities/${id}` })).statusCode).toBe(404);

    await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${id}`,
      headers: bearer(reviewerToken),
      payload: { isListed: true },
    });
    expect((await app.inject({ url: `/v1/opportunities/${id}` })).statusCode).toBe(200);
  });

  it("flips a whole namespace to auto-approval by verifying its organisation, and back", async () => {
    const before = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:before`, CANDIDATE),
    });
    expect(before.json().reviewStatus).toBe("pending");

    const verified = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${CANDIDATE}/verify`,
      headers: bearer(reviewerToken),
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verified).toBe(true);

    const after = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:after`, CANDIDATE),
    });
    expect(after.json().reviewStatus).toBe("approved");

    await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${CANDIDATE}/unverify`,
      headers: bearer(reviewerToken),
    });
    const afterUnverify = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:after-unverify`, CANDIDATE),
    });
    expect(afterUnverify.json().reviewStatus).toBe("pending");
  });

  it("removes auto-approval the moment a membership is revoked", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${CANDIDATE}/verify`,
      headers: bearer(reviewerToken),
    });
    const granted = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:member-on`, CANDIDATE),
    });
    expect(granted.json().reviewStatus).toBe("approved");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/review/organizations/${CANDIDATE}/members/${memberId}`,
      headers: bearer(reviewerToken),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().member).toBe(false);

    const after = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:member-off`, CANDIDATE),
    });
    expect(after.json().reviewStatus).toBe("pending");

    // …and granting it back restores it, immediately.
    const regranted = await app.inject({
      method: "POST",
      url: `/v1/review/organizations/${CANDIDATE}/members`,
      headers: bearer(reviewerToken),
      payload: { accountId: memberId, role: "owner" },
    });
    expect(regranted.json().member).toBe(true);
    const again = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(memberToken),
      payload: submission(`${CANDIDATE}:member-again`, CANDIDATE),
    });
    expect(again.json().reviewStatus).toBe("approved");
  });

  it("serializes two concurrent grants of the same previously-absent membership", async () => {
    // The read (is there already a membership row?) and the insert are not one atomic step, so two
    // concurrent grants for the SAME, previously ungranted (account, organisation) pair can both
    // see no row and both attempt the insert. The unique index lets one in and raises a conflict at
    // the other; the grant is documented as idempotent, so BOTH requests must come back 200 with
    // `member: true`, and exactly one row must exist — never a 500 for an otherwise ordinary grant.
    const fresh = await seedIdentity(EMAILS.raceMember, { handle: "m3rev-race-member" });
    userIds.push(fresh.userId);

    const grant = () =>
      app.inject({
        method: "POST",
        url: `/v1/review/organizations/${CANDIDATE}/members`,
        headers: bearer(reviewerToken),
        payload: { accountId: fresh.account.id, role: "publisher" },
      });
    const [first, second] = await Promise.all([grant(), grant()]);

    for (const res of [first, second]) {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().member).toBe(true);
      expect(res.json().role).toBe("publisher");
    }

    const rows = await db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.accountId, fresh.account.id),
          eq(orgMemberships.organizationId, candidateOrgId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("publisher");
  });

  it("edits organisation metadata through the reviewer route, audited, without touching verified", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/review/organizations/${CANDIDATE}`,
      headers: bearer(reviewerToken),
      payload: { name: "Candidate Foundation", website: "https://candidate.example" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Candidate Foundation");
    expect(res.json().verified).toBe(true);
  });

  it("lets an organisation's own owner edit it, and refuses an unrelated account", async () => {
    const mine = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${CANDIDATE}`,
      headers: bearer(memberToken),
      payload: { description: "Written by its owner." },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().slug).toBe(CANDIDATE);

    const theirs = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${CANDIDATE}`,
      headers: bearer(submitterToken),
      payload: { description: "Written by a stranger." },
    });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error).toBe("not_an_org_manager");
  });

  it("keeps role assignment to T4 and account/organisation discovery to T3", async () => {
    // Re-resolves the SAME account `beforeAll` already seeded — `signIn` caches per address, so
    // this reuses the submitter's identity to promote its existing account, rather than minting a
    // second one.
    const target = await seedAccount({ userId: (await signIn(EMAILS.submitter)).userId });
    const byReviewer = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${target.id}/role`,
      headers: bearer(reviewerToken),
      payload: { role: "reviewer" },
    });
    expect(byReviewer.statusCode).toBe(403);

    const byAdmin = await app.inject({
      method: "POST",
      url: `/v1/admin/accounts/${target.id}/role`,
      headers: bearer(adminToken),
      payload: { role: "reviewer" },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().globalRole).toBe("reviewer");
    // The projection never carries the identity-provider subject or the email.
    expect(Object.keys(byAdmin.json()).sort()).toEqual([
      "createdAt",
      "directCreate",
      "displayName",
      "globalRole",
      "handle",
      "id",
    ]);

    const accounts = await app.inject({
      method: "GET",
      url: "/v1/review/accounts?q=m3rev-member",
      headers: bearer(reviewerToken),
    });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().items.map((a: { handle: string }) => a.handle)).toContain(
      "m3rev-member",
    );

    const orgs = await app.inject({
      method: "GET",
      url: "/v1/review/organizations?verified=true",
      headers: bearer(reviewerToken),
    });
    expect(orgs.json().items.every((o: { verified: boolean }) => o.verified)).toBe(true);
  });

  it("serves the public publisher list, and lists only verified organisations", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/publishers" });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(CANDIDATE);
    expect(slugs).not.toContain(NS);
    expect(res.json().total).toBeGreaterThan(0);
    // No contact details on an unauthenticated endpoint.
    expect(JSON.stringify(res.json())).not.toContain("contacts");
  });

  it("does not leak an approved entry's editorial columns into the public detail body", async () => {
    const id = `${NS}:to-approve`;
    const body = (await app.inject({ url: `/v1/opportunities/${id}` })).json();
    for (const field of ["reviewStatus", "isListed", "submittedBy", "approvedBy"]) {
      expect(body[field], field).toBeUndefined();
    }
    const row = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1)
    )[0];
    expect(row?.approvedBy).not.toBeNull();
  });
});
