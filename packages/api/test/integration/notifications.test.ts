/**
 * Duplicate notifications end to end: emission, recipients, privacy, idempotency and inbox state.
 *
 * Isolation tag: `M3NOTE` / `m3note:`.
 *
 * This file sets the lexical provider before dynamically importing anything that can reach config,
 * for the same module-load reason documented in duplicates.test.ts.
 */
process.env.EMBEDDING_PROVIDER = "lexical";

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LEDGER_BODY, reword } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const OUTBOX_DIR = await mkdtemp(join(tmpdir(), "rfphub-notification-email-"));
process.env.EMAIL_TRANSPORT = "file";
process.env.EMAIL_OUTBOX_DIR = OUTBOX_DIR;
process.env.APP_BASE_URL = "https://app.example.org";

const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { notifications, opportunities, opportunityDuplicates } = await import(
  "../../src/db/schema.js"
);
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");
const { notificationDispatchQueue } = await import(
  "../../src/modules/services/notifications/notification-dispatch.queue.js"
);
const { bearer, grantMembership, mintApiKeyFor, seedIdentity, seedOrganization, testAuth } =
  await import("../helpers/auth.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");

const PUBLIC_NS = "m3note-public";
const PRIVATE_NS = "m3note-private";
const PUBLIC_ID = `${PUBLIC_NS}:original`;
const PRIVATE_ID = `${PRIVATE_NS}:submission`;
const EMAILS = {
  publicOwner: "m3note-public-owner@rfphub.invalid",
  namespacePeer: "m3note-namespace-peer@rfphub.invalid",
  privateOwner: "m3note-private-owner@rfphub.invalid",
  reviewerOwner: "m3note-reviewer-owner@rfphub.invalid",
  reviewerOnly: "m3note-reviewer-only@rfphub.invalid",
};

const run = describeWithDb;

function entry(id: string, namespace: string, title: string, description: string) {
  return submission(id, namespace, {
    title,
    description,
    ecosystems: ["M3NOTE"],
  } as Record<string, unknown>);
}

/**
 * Establish this suite's lexical corpus before concurrent files can make the shared database look
 * like a provider switch. The sentinel is deliberately unrelated to the notification pair and has
 * no owning organization, so it can neither match nor receive an event.
 */
async function seedCompatibleCorpus(): Promise<void> {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: "m3notecoverage:sentinel",
      fundingType: "accelerator",
      status: "open",
      title: "Pelagic taxonomy field fellowship",
      description:
        "Marine biologists catalogue deep-ocean invertebrates during a research voyage and deposit preserved specimens in a public natural-history collection.",
      operatingOrganizations: [{ name: "M3NOTE coverage fixture", slug: "m3notecoverage" }],
      reviewStatus: "approved",
      isListed: true,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("failed to seed the lexical corpus sentinel");
  await new DedupeService().embedAndDetect(id, "public");
}

run("M3NOTE duplicate notifications", () => {
  let app: FastifyInstance;
  let publicOwnerToken: string;
  let privateOwnerToken: string;
  let reviewerToken: string;
  let privateOwnerReadKey: string;
  let publicOwnerId: number;
  let namespacePeerId: number;
  let privateOwnerId: number;
  let reviewerOwnerId: number;
  let reviewerOnlyId: number;
  let pairId: number;
  const userIds: string[] = [];

  const pairBetween = async () => {
    const rows = await db
      .select({ pair: opportunityDuplicates })
      .from(opportunityDuplicates)
      .innerJoin(
        opportunities,
        or(
          eq(opportunities.id, opportunityDuplicates.opportunityId),
          eq(opportunities.id, opportunityDuplicates.duplicateOfId),
        ),
      )
      .where(or(eq(opportunities.publicId, PUBLIC_ID), eq(opportunities.publicId, PRIVATE_ID)));
    const counts = new Map<number, number>();
    for (const { pair } of rows) counts.set(pair.id, (counts.get(pair.id) ?? 0) + 1);
    const candidate = rows.find(({ pair }) => counts.get(pair.id) === 2)?.pair;
    if (!candidate) throw new Error("notification fixtures did not produce their duplicate pair");
    return candidate;
  };

  const rowsFor = async (kind: (typeof notifications.kind.enumValues)[number]) =>
    db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.subjectKind, "duplicate"),
          eq(notifications.subjectId, pairId),
          eq(notifications.kind, kind),
        ),
      );

  const waitForDispatch = async (ids: number[]) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await db
        .select()
        .from(notifications)
        .where(or(...ids.map((id) => eq(notifications.id, id))));
      if (rows.length === ids.length && rows.every((row) => row.emailDispatchedAt !== null)) {
        return rows;
      }
      if (Date.now() >= deadline) throw new Error("immediate notification email did not dispatch");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publicOwner = await seedIdentity(EMAILS.publicOwner, { handle: "m3note-public-owner" });
    const namespacePeer = await seedIdentity(EMAILS.namespacePeer, {
      handle: "m3note-namespace-peer",
    });
    const privateOwner = await seedIdentity(EMAILS.privateOwner, {
      handle: "m3note-private-owner",
    });
    const reviewerOwner = await seedIdentity(EMAILS.reviewerOwner, {
      handle: "m3note-reviewer-owner",
      role: "reviewer",
    });
    const reviewerOnly = await seedIdentity(EMAILS.reviewerOnly, {
      handle: "m3note-reviewer-only",
      role: "reviewer",
    });
    userIds.push(
      publicOwner.userId,
      namespacePeer.userId,
      privateOwner.userId,
      reviewerOwner.userId,
      reviewerOnly.userId,
    );

    const publicOrg = await seedOrganization({ slug: PUBLIC_NS, verified: true });
    await seedOrganization({ slug: PRIVATE_NS, verified: false });
    await grantMembership(publicOwner.account.id, publicOrg.id, "owner");
    await grantMembership(namespacePeer.account.id, publicOrg.id, "publisher");
    // The acting reviewer is also a real owner of the public side. They should receive exactly one
    // row in that capacity, never an extra row merely because they performed the decision.
    await grantMembership(reviewerOwner.account.id, publicOrg.id, "publisher");
    await seedCompatibleCorpus();

    publicOwnerToken = publicOwner.token;
    privateOwnerToken = privateOwner.token;
    reviewerToken = reviewerOwner.token;
    privateOwnerReadKey = await mintApiKeyFor(privateOwner.account.id, ["read"]);
    publicOwnerId = publicOwner.account.id;
    namespacePeerId = namespacePeer.account.id;
    privateOwnerId = privateOwner.account.id;
    reviewerOwnerId = reviewerOwner.account.id;
    reviewerOnlyId = reviewerOnly.account.id;
  });

  afterAll(async () => {
    const deadline = Date.now() + 5_000;
    while (notificationDispatchQueue.queueDepth > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await cleanupFixtures({
      opportunityPrefix: "m3note",
      organizationSlugs: [PUBLIC_NS, PRIVATE_NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
    await rm(OUTBOX_DIR, { recursive: true, force: true });
  });

  it("notifies both owner sets only for a newly-created suspected pair and keeps a private counterpart anonymous", async () => {
    const published = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publicOwnerToken),
      payload: entry(PUBLIC_ID, PUBLIC_NS, "Regional Seed Bank Fund", LEDGER_BODY),
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().reviewStatus).toBe("approved");

    const pending = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(privateOwnerToken),
      payload: entry(
        PRIVATE_ID,
        PRIVATE_NS,
        "Regional Seed Bank Fund — community submission",
        reword(LEDGER_BODY),
      ),
    });
    expect(pending.statusCode, pending.body).toBe(201);
    expect(pending.json().reviewStatus).toBe("pending");
    expect(pending.json().duplicates.map((item: { id: string }) => item.id)).toContain(PUBLIC_ID);

    pairId = (await pairBetween()).id;
    const suspected = await rowsFor("duplicate_suspected");
    expect(suspected.map((row) => row.accountId).sort((a, b) => a - b)).toEqual(
      [publicOwnerId, namespacePeerId, privateOwnerId, reviewerOwnerId].sort((a, b) => a - b),
    );
    const delivered = await waitForDispatch(suspected.map((row) => row.id));
    expect(delivered.every((row) => row.emailFailedAt === null)).toBe(true);
    const privateOutbox = join(
      OUTBOX_DIR,
      `${createHash("sha256").update(EMAILS.privateOwner).digest("hex")}.jsonl`,
    );
    const mail = await readFile(privateOutbox, "utf8");
    expect(mail).toContain('"subject":"A possible duplicate was found"');
    expect(mail).toContain("Regional Seed Bank Fund — community submission");
    expect(mail).toContain("https://app.example.org/duplicates");

    const publicSide = suspected.find((row) => row.accountId === publicOwnerId);
    expect(publicSide?.payload).toMatchObject({
      pairId,
      yourListing: { id: PUBLIC_ID, title: "Regional Seed Bank Fund" },
      action: "review_match",
      link: "/duplicates",
      decidedBy: null,
    });
    expect(publicSide?.payload).not.toHaveProperty("otherListing");
    expect(JSON.stringify(publicSide?.payload)).not.toContain(PRIVATE_ID);
    expect(JSON.stringify(publicSide?.payload)).not.toContain("community submission");

    const privateSide = suspected.find((row) => row.accountId === privateOwnerId);
    expect(privateSide?.payload).toMatchObject({
      pairId,
      yourListing: { id: PRIVATE_ID },
      otherListing: { id: PUBLIC_ID, title: "Regional Seed Bank Fund" },
      similarity: expect.any(Number),
    });

    // The acting reviewer is an owner through the namespace and appears once; a reviewer with no
    // ownership relationship receives nothing.
    expect(suspected.filter((row) => row.accountId === reviewerOwnerId)).toHaveLength(1);
    expect(suspected.some((row) => row.accountId === reviewerOnlyId)).toBe(false);

    const privateRow = (
      await db.select().from(opportunities).where(eq(opportunities.publicId, PRIVATE_ID)).limit(1)
    )[0];
    if (!privateRow) throw new Error("private notification fixture disappeared");
    await new DedupeService().embedAndDetect(privateRow.id, "public");
    expect(await rowsFor("duplicate_suspected")).toHaveLength(4);
  });

  it("records confirmed and dismissed notifications once per owner with a coarsened decider", async () => {
    for (const action of ["confirm", "dismiss", "dismiss"] as const) {
      const result = await app.inject({
        method: "POST",
        url: `/v1/review/duplicates/${pairId}/${action}`,
        headers: bearer(reviewerToken),
      });
      expect(result.statusCode, result.body).toBe(200);
    }

    for (const kind of ["duplicate_confirmed", "duplicate_dismissed"] as const) {
      const rows = await rowsFor(kind);
      expect(rows.map((row) => row.accountId).sort((a, b) => a - b)).toEqual(
        [publicOwnerId, namespacePeerId, privateOwnerId, reviewerOwnerId].sort((a, b) => a - b),
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.payload).toMatchObject({ pairId, decidedBy: "reviewer" });
        expect(row.payload).not.toHaveProperty("decidedAccountId");
      }
      const ownerView = rows.find((row) => row.accountId === publicOwnerId);
      expect(ownerView?.payload).not.toHaveProperty("otherListing");
    }
  });

  it("notifies both owner sets when a dismissal is genuinely reopened, but not on a no-op", async () => {
    const reopened = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pairId}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().status).toBe("suspected");

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pairId}/reopen`,
      headers: bearer(reviewerToken),
    });
    expect(repeated.statusCode, repeated.body).toBe(200);

    const rows = await rowsFor("duplicate_reopened");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.payload.decidedBy === "reviewer")).toBe(true);
  });

  it("emits merged-away to the loser and absorbed to the survivor owners with emission-time privacy", async () => {
    const merged = await app.inject({
      method: "POST",
      url: `/v1/review/duplicates/${pairId}/merge`,
      headers: bearer(reviewerToken),
      payload: { survivorId: PUBLIC_ID },
    });
    expect(merged.statusCode, merged.body).toBe(200);

    const away = await rowsFor("duplicate_merged_away");
    expect(away).toHaveLength(1);
    expect(away[0]).toMatchObject({ accountId: privateOwnerId });
    expect(away[0]?.payload).toMatchObject({
      yourListing: { id: PRIVATE_ID },
      otherListing: { id: PUBLIC_ID, title: "Regional Seed Bank Fund" },
      action: "view_survivor",
      link: `/opportunities/${encodeURIComponent(PUBLIC_ID)}`,
      decidedBy: "reviewer",
    });

    const absorbed = await rowsFor("duplicate_absorbed");
    expect(absorbed.map((row) => row.accountId).sort((a, b) => a - b)).toEqual(
      [publicOwnerId, namespacePeerId, reviewerOwnerId].sort((a, b) => a - b),
    );
    expect(absorbed.every((row) => !("otherListing" in row.payload))).toBe(true);
  });

  it("lists newest first with pagination and lets a read-only API key mark one or all read", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/me/notifications?page=1&limit=2",
      headers: bearer(privateOwnerReadKey),
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json()).toMatchObject({ page: 1, limit: 2, totalPages: expect.any(Number) });
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().unreadCount).toBe(firstPage.json().total);
    expect(
      firstPage
        .json()
        .items.every((item: { subjectKind: string }) => item.subjectKind === "duplicate"),
    ).toBe(true);
    const instants = firstPage
      .json()
      .items.map((item: { createdAt: string }) => new Date(item.createdAt).getTime());
    expect(instants).toEqual([...instants].sort((a, b) => b - a));

    const target = firstPage.json().items[0] as { id: number; readAt: null };
    const marked = await app.inject({
      method: "POST",
      url: `/v1/me/notifications/${target.id}/read`,
      headers: bearer(privateOwnerReadKey),
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().readAt).toEqual(expect.any(String));
    const originalReadAt = marked.json().readAt;

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/me/notifications/${target.id}/read`,
      headers: bearer(privateOwnerReadKey),
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().readAt).toBe(originalReadAt);

    const total = firstPage.json().total as number;
    const unreadTotal = total - 1;
    const pageLimit = 2;

    const unread = await app.inject({
      method: "GET",
      url: `/v1/me/notifications?unread=true&page=1&limit=${pageLimit}`,
      headers: bearer(privateOwnerReadKey),
    });
    expect(unread.statusCode, unread.body).toBe(200);
    expect(unread.json()).toMatchObject({
      page: 1,
      limit: pageLimit,
      total: unreadTotal,
      totalPages: Math.max(1, Math.ceil(unreadTotal / pageLimit)),
      unreadCount: unreadTotal,
    });
    expect(unread.json().items).toHaveLength(Math.min(pageLimit, unreadTotal));
    expect(unread.json().items.every((item: { readAt: null }) => item.readAt === null)).toBe(true);
    expect(unread.json().items.map((item: { id: number }) => item.id)).not.toContain(target.id);

    const read = await app.inject({
      method: "GET",
      url: "/v1/me/notifications?unread=false&page=1&limit=1",
      headers: bearer(privateOwnerReadKey),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
      unreadCount: unreadTotal,
    });
    expect(read.json().items).toEqual([
      expect.objectContaining({ id: target.id, readAt: originalReadAt }),
    ]);

    const unfiltered = await app.inject({
      method: "GET",
      url: `/v1/me/notifications?page=1&limit=${pageLimit}`,
      headers: bearer(privateOwnerReadKey),
    });
    expect(unfiltered.statusCode, unfiltered.body).toBe(200);
    expect(unfiltered.json()).toMatchObject({
      page: 1,
      limit: pageLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageLimit)),
      unreadCount: unreadTotal,
    });
    expect(unfiltered.json().items).toHaveLength(Math.min(pageLimit, total));
    expect(unfiltered.json().items.map((item: { id: number }) => item.id)).toContain(target.id);
    expect(unfiltered.json().items.map((item: { readAt: string | null }) => item.readAt)).toEqual(
      expect.arrayContaining([originalReadAt, null]),
    );

    const somebodyElses = (
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.accountId, publicOwnerId))
        .limit(1)
    )[0];
    if (!somebodyElses) throw new Error("public owner has no notification fixture");
    const denied = await app.inject({
      method: "POST",
      url: `/v1/me/notifications/${somebodyElses.id}/read`,
      headers: bearer(privateOwnerReadKey),
    });
    expect(denied.statusCode).toBe(404);

    const all = await app.inject({
      method: "POST",
      url: "/v1/me/notifications/read-all",
      headers: bearer(privateOwnerReadKey),
    });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json()).toEqual({ markedRead: unreadTotal, unreadCount: 0 });

    const settled = await app.inject({
      method: "GET",
      url: "/v1/me/notifications?unread=true",
      headers: bearer(privateOwnerToken),
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ items: [], total: 0, unreadCount: 0 });
  });
});
