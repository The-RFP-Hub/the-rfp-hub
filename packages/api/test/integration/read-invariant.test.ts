import { and, eq, or } from "drizzle-orm";
/**
 * THE PUBLIC READ INVARIANT, re-proved after every mutation type this wave introduces.
 *
 * `approved AND is_listed` is the only definition of "public", and the list, the detail, the feeds,
 * the export and the stats all read it through the same service. M3 adds new ways for a row to
 * change state — a pending submission, an auto-approved publisher write, a rejection, an unlisting,
 * a granted claim — and each of them is a chance for one surface to disagree with the others.
 *
 * So: after every one of them, the five surfaces are asked what they contain, and they must contain
 * exactly the same set.
 *
 * Isolation tag: `M3INV` / `m3inv:`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, opportunityDuplicates } from "../../src/db/schema.js";
import { DedupeService } from "../../src/modules/services/dedupe/dedupe.service.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3inv";
const EMAILS = {
  publisher: "m3inv-publisher@rfphub.invalid",
  submitter: "m3inv-submitter@rfphub.invalid",
  reviewer: "m3inv-reviewer@rfphub.invalid",
};

const run = describeWithDb;

run("M3INV the public read invariant", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let submitterToken: string;
  let reviewerToken: string;
  let reviewerId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3inv-publisher" });
    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m3inv-submitter" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3inv-reviewer",
      role: "reviewer",
    });
    userIds.push(publisher.userId, submitter.userId, reviewer.userId);
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    publisherToken = publisher.token;
    submitterToken = submitter.token;
    reviewerToken = reviewer.token;
    reviewerId = reviewer.account.id;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  /** What each public surface says is in this fixture's ecosystem, as a sorted id list. */
  async function surfaces(): Promise<Record<string, string[]>> {
    const ours = (ids: string[]) => ids.filter((id) => id.startsWith(`${NS}:`)).sort();

    const list = await app.inject({ url: `/v1/opportunities?ecosystem=${NS.toUpperCase()}` });
    const exported = await app.inject({ url: "/v1/export/opportunities.json" });
    const atom = await app.inject({ url: "/v1/feeds/opportunities.atom" });
    const csv = await app.inject({ url: "/v1/export/opportunities.csv" });

    return {
      list: ours(list.json().items.map((i: { id: string }) => i.id)),
      export: ours(exported.json().opportunities.map((o: { id: string }) => o.id)),
      // The feed and the CSV are text; matching the id where it appears is enough to say whether
      // the record is in them.
      feed: ours([...atom.body.matchAll(/m3inv:[a-z0-9-]+/g)].map((m) => m[0])),
      csv: ours([...csv.body.matchAll(/m3inv:[a-z0-9-]+/g)].map((m) => m[0])),
    };
  }

  async function expectPublic(expected: string[]) {
    const found = await surfaces();
    const want = [...new Set(expected)].sort();
    for (const [name, ids] of Object.entries(found)) {
      expect([...new Set(ids)], `${name} surface`).toEqual(want);
    }
    // …and the detail route agrees, one id at a time.
    for (const id of want) {
      expect((await app.inject({ url: `/v1/opportunities/${id}` })).statusCode, id).toBe(200);
    }
  }

  it("starts empty", async () => {
    await expectPublic([]);
  });

  it("keeps a pending submission out of every surface", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(submitterToken),
      payload: submission(`${NS}:pending`, NS, { ecosystems: ["M3INV"] }),
    });
    expect(res.json().reviewStatus).toBe("pending");
    await expectPublic([]);
  });

  it("keeps a pending loser's merged destination private", async () => {
    const survivorId = `${NS}:merge-survivor`;
    const loserId = `${NS}:merge-pending`;
    for (const [token, id] of [
      [publisherToken, survivorId],
      [submitterToken, loserId],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: bearer(token),
        payload: submission(id, NS, { ecosystems: ["M3INV"] }),
      });
      expect(created.statusCode, created.body).toBe(201);
    }

    const rows = await db
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(eq(opportunities.sourcePublisher, NS));
    const byPublicId = new Map(rows.map((row) => [row.publicId, row.id]));
    const low = Math.min(byPublicId.get(survivorId) as number, byPublicId.get(loserId) as number);
    const high = Math.max(byPublicId.get(survivorId) as number, byPublicId.get(loserId) as number);
    // With deterministic embeddings, submit-time detection has already inserted this pair. With
    // embeddings disabled (the local default), the test must create it itself. Resolve either
    // orientation before inserting so the invariant is proved in both environments without
    // violating the unordered pair's expression-backed unique index.
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
    expect(pair, "the merge pair exists with either embedding configuration").toBeDefined();
    await new DedupeService().merge(reviewerId, pair?.id as number, {
      survivorId,
    });

    const response = await app.inject({ url: `/v1/opportunities/${loserId}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "not_found",
      message: `opportunity '${loserId}' not found`,
    });
    expect(response.json()).not.toHaveProperty("mergedInto");

    const hidden = await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${survivorId}`,
      headers: bearer(reviewerToken),
      payload: { isListed: false },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
  });

  it("puts an auto-approved publisher write into all of them at once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publisherToken),
      payload: submission(`${NS}:live`, NS, { ecosystems: ["M3INV"] }),
    });
    expect(res.json().reviewStatus).toBe("approved");
    await expectPublic([`${NS}:live`]);
  });

  it("adds a reviewer-approved entry, and removes a rejected one", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:pending/approve`,
      headers: bearer(reviewerToken),
      payload: {},
    });
    await expectPublic([`${NS}:live`, `${NS}:pending`]);

    await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:pending/reject`,
      headers: bearer(reviewerToken),
      payload: { reason: "changed our mind" },
    });
    await expectPublic([`${NS}:live`]);
  });

  it("removes an unlisted entry and restores a relisted one", async () => {
    await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${NS}:live`,
      headers: bearer(reviewerToken),
      payload: { isListed: false },
    });
    await expectPublic([]);

    await app.inject({
      method: "PATCH",
      url: `/v1/review/opportunities/${NS}:live`,
      headers: bearer(reviewerToken),
      payload: { isListed: true },
    });
    await expectPublic([`${NS}:live`]);
  });

  it("keeps a replace in every surface, with the new content", async () => {
    await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${NS}:live`,
      headers: bearer(publisherToken),
      payload: submission(`${NS}:live`, NS, { ecosystems: ["M3INV"], title: "Renamed" }),
    });
    await expectPublic([`${NS}:live`]);
    expect((await app.inject({ url: `/v1/opportunities/${NS}:live` })).json().title).toBe(
      "Renamed",
    );
  });

  /**
   * The stats total and the export count are two reads of one predicate, taken a moment apart —
   * and sibling suites seed and remove their own fixtures throughout the run, so the dataset can
   * legitimately move between them. Retried until a settled pair is observed, asserting
   * unconditionally on the last attempt so a genuine disagreement fails with the numbers.
   */
  it("counts exactly the public set in /v1/stats", async () => {
    const ATTEMPTS = 20;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const total = (await app.inject({ url: "/v1/stats" })).json().total;
      const count = (await app.inject({ url: "/v1/export/opportunities.json" })).json().count;
      if (total === count || attempt === ATTEMPTS - 1) {
        expect(total).toBe(count);
        return;
      }
    }
  });
});
