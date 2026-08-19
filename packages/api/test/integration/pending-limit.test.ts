/**
 * The ceiling on how much of the review queue one account may occupy at once.
 *
 * The queue is a shared resource and reviewing is human work, so an account that can leave an
 * unbounded number of entries waiting can deny that work to everyone else — at no cost to itself.
 * The cap is deliberately a CEILING ON THE QUEUE rather than a quota on a lifetime: every decision
 * a reviewer makes frees a slot, so a person acting in good faith meets it once, waits for an
 * answer, and continues.
 *
 * WHO IT DOES NOT APPLY TO: anybody holding a verified membership anywhere. Their own writes
 * auto-approve and never reach the queue at all, and metering their proposals into OTHER namespaces
 * because of where they publish would meter exactly the people the Hub has already vouched for.
 *
 * Isolation tag: `M3CAP` / `m3cap*`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/client.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
  testAuthConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3cap";
const VERIFIED_NS = "m3cap-verified";
const EMAILS = {
  capped: "m3cap-capped@rfphub.invalid",
  racer: "m3cap-racer@rfphub.invalid",
  requeuer: "m3cap-requeuer@rfphub.invalid",
  publisher: "m3cap-publisher@rfphub.invalid",
};
const HANDLES = ["m3cap-capped", "m3cap-racer", "m3cap-publisher", "m3cap-requeuer"];

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
const LIMIT = config.pendingSubmissionLimit;

run("M3CAP the pending-submission ceiling", () => {
  let app: FastifyInstance;
  let cappedToken: string;
  let racerToken: string;
  let requeuerToken: string;
  let publisherToken: string;
  let reviewerToken: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
    await cleanupFixtures({
      opportunityPrefix: NS,
      handles: HANDLES,
      emails: Object.values(EMAILS),
    });

    await seedOrganization({ slug: NS, verified: false });
    const verified = await seedOrganization({ slug: VERIFIED_NS, verified: true });

    const capped = await seedIdentity(EMAILS.capped, { handle: "m3cap-capped" });
    const racer = await seedIdentity(EMAILS.racer, { handle: "m3cap-racer" });
    const requeuer = await seedIdentity(EMAILS.requeuer, { handle: "m3cap-requeuer" });
    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3cap-publisher" });
    const reviewer = await seedIdentity("m3cap-reviewer@rfphub.invalid", { role: "reviewer" });
    userIds.push(capped.userId, racer.userId, publisher.userId, reviewer.userId, requeuer.userId);
    await grantMembership(publisher.account.id, verified.id);

    cappedToken = capped.token;
    racerToken = racer.token;
    requeuerToken = requeuer.token;
    publisherToken = publisher.token;
    reviewerToken = reviewer.token;
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS, VERIFIED_NS],
      handles: HANDLES,
      userIds,
      emails: [...Object.values(EMAILS), "m3cap-reviewer@rfphub.invalid"],
    });
    await app.close();
    await pool.end();
  }, 60_000);

  const submit = async (id: string, token: string, namespace = NS) =>
    app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: submission(id, namespace, { ecosystems: ["M3CAP"] }),
    });

  it("accepts submissions up to the limit and refuses the one after it", async () => {
    for (let n = 0; n < LIMIT; n++) {
      const res = await submit(`${NS}:capped-${n}`, cappedToken);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().reviewStatus).toBe("pending");
    }

    const refused = await submit(`${NS}:capped-over`, cappedToken);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("pending_limit_reached");
    // The message has to say what to do about it, not merely that it happened: the count, the cap,
    // and the fact that a slot frees on its own once somebody reviews.
    expect(refused.json().message).toContain(String(LIMIT));
    expect(refused.json().message).toMatch(/approved or rejected/);

    // Refused means NOT WRITTEN — a partially-created row would be a worse outcome than the refusal.
    const detail = await app.inject({
      method: "GET",
      url: `/v1/me/opportunities/${NS}:capped-over`,
      headers: bearer(cappedToken),
    });
    expect(detail.statusCode).toBe(404);
  }, 60_000);

  it("frees a slot as soon as one of them is reviewed", async () => {
    // The whole design in one case: the cap is a ceiling on the QUEUE, so it moves as the queue does.
    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:capped-0/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const accepted = await submit(`${NS}:capped-after-review`, cappedToken);
    expect(accepted.statusCode, accepted.body).toBe(201);
  }, 60_000);

  it("does not count a REPLACEMENT of something already pending", async () => {
    // A `PUT` on an entry that is already in the queue occupies the same slot it always did. Counting
    // it again would mean an account at the cap could no longer correct its own submissions, which
    // is the opposite of what a review queue wants.
    const id = `${NS}:capped-1`;
    const replaced = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(cappedToken),
      payload: submission(id, NS, { title: "Corrected title", ecosystems: ["M3CAP"] }),
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().opportunity.title).toBe("Corrected title");
  }, 60_000);

  it("exempts an account that publishes for a verified organisation, wherever it submits", async () => {
    // Their in-namespace writes auto-approve and never touch the queue; this is about the OTHER
    // namespaces they may propose into, which are metered for everybody else. The exemption is
    // total on purpose — the Hub has already vouched for this person somewhere.
    for (let n = 0; n < LIMIT + 2; n++) {
      const res = await submit(`${NS}:publisher-${n}`, publisherToken);
      expect(res.statusCode, res.body).toBe(201);
      // Into somebody ELSE's namespace, so these really are pending and really do sit in the queue.
      expect(res.json().reviewStatus).toBe("pending");
    }
  }, 60_000);

  it("charges a REQUEUE too — editing old entries is not a way around the ceiling", async () => {
    // THE BYPASS THIS CLOSES. A content-changing replacement of an approved or rejected entry
    // returns it to the queue, so an account at its limit could edit its own older entries one
    // after another and grow the queue without ever creating anything. The slot is charged on the
    // transition INTO the queue, whatever caused it.
    const id = `${NS}:requeue-me`;
    expect((await submit(id, requeuerToken)).statusCode).toBe(201);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${id}/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // Back to the cap, with pending entries only — this account now holds exactly LIMIT of them
    // and the approved entry above is not among them.
    for (let n = 0; n < LIMIT; n++) {
      expect((await submit(`${NS}:filler-${n}`, requeuerToken)).statusCode).toBe(201);
    }
    expect((await submit(`${NS}:filler-over`, requeuerToken)).statusCode).toBe(409);

    const requeued = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(requeuerToken),
      payload: submission(id, NS, { title: "Rewritten while at the cap", ecosystems: ["M3CAP"] }),
    });
    expect(requeued.statusCode, requeued.body).toBe(409);
    expect(requeued.json().error).toBe("pending_limit_reached");

    // …and the entry is untouched: still approved, still carrying its original title.
    const stored = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${id}`,
      headers: PUBLIC_READ,
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().title).not.toBe("Rewritten while at the cap");
  }, 60_000);

  it("does not charge an edit of something ALREADY pending, even at the cap", async () => {
    // The other half: a pending entry occupies the slot it already holds. Charging it again would
    // stop an account at the limit from correcting its own submissions.
    const id = `${NS}:capped-2`;
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(cappedToken),
      payload: submission(id, NS, { title: "Corrected while at the cap", ecosystems: ["M3CAP"] }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().reviewStatus).toBe("pending");
  }, 60_000);

  it("holds the line against two creates racing at the cap", async () => {
    // COUNT-THEN-INSERT IS NOT ATOMIC BY ITSELF: two requests that both counted `LIMIT - 1` would
    // both insert, and the account would end up one over. The account row is the serialisation
    // point — the same one `api-key.service.ts` uses for the 25-key limit — and this proves it by
    // parking both requests behind a barrier that holds that row.
    for (let n = 0; n < LIMIT - 1; n++) {
      expect((await submit(`${NS}:racer-${n}`, racerToken)).statusCode).toBe(201);
    }

    const barrier = await openLockBarrier();
    const both = [] as ReturnType<typeof submit>[];
    try {
      await barrier.run("select id from accounts where handle = $1 for update", ["m3cap-racer"]);
      both.push(submit(`${NS}:racer-a`, racerToken));
      await barrier.waitForWaiters(1);
      both.push(submit(`${NS}:racer-b`, racerToken));
      await barrier.waitForWaiters(2);
    } finally {
      await barrier.rollback();
    }

    const settled = await Promise.all(both);
    const outcomes = settled.map((res) => res.statusCode);
    const diagnosis = JSON.stringify(settled.map((r) => [r.statusCode, r.body.slice(0, 120)]));
    // Exactly one gets the last slot. Which one is the database's business; that it is one is ours.
    expect(
      outcomes.filter((code) => code === 201),
      diagnosis,
    ).toHaveLength(1);
    expect(
      outcomes.filter((code) => code === 409),
      diagnosis,
    ).toHaveLength(1);
  }, 60_000);
});
