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
import { pool } from "../../src/db/client.js";
import {
  bearer,
  grantMembership,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3inv";
const DIDS = {
  publisher: "did:privy:m3inv-publisher",
  submitter: "did:privy:m3inv-submitter",
  reviewer: "did:privy:m3inv-reviewer",
};

const run = describeWithDb;

run("M3INV the public read invariant", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let submitterToken: string;
  let reviewerToken: string;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();
    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3inv-publisher" });
    await seedAccount({ did: DIDS.submitter, handle: "m3inv-submitter" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3inv-reviewer", role: "reviewer" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.id, org.id, "owner");
    publisherToken = await mintPrivyToken(DIDS.publisher);
    submitterToken = await mintPrivyToken(DIDS.submitter);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      privyDids: Object.values(DIDS),
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
