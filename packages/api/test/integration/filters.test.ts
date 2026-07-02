/**
 * Exercises every documented /v1/opportunities query param + sort + pagination against real
 * Postgres, with isolated self-cleaning fixtures (ecosystem "FILTERTEST", ids "ftest:*").
 * Gated on DATABASE_URL. This is the "honor every documented query param" coverage.
 */
import type { Opportunity } from "@rfp-hub/standard";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityController } from "../../src/modules/controller/Opportunity.controller.js";

const TAG = "FILTERTEST";

const FIXTURES: Opportunity[] = [
  {
    specVersion: "1.0.0",
    id: "ftest:a",
    type: "grant",
    title: "Alpha DeFi grant",
    description: "Grants for DeFi builders.",
    status: "open",
    organization: { name: "Org A", slug: "org-a" },
    source: { url: "https://example.com/a", ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG, "Optimism"],
    networks: ["optimism"],
    categories: ["DeFi"],
    tags: ["retro"],
    funding: { minAward: 1000, maxAward: 5000, currency: "USD" },
    closesAt: "2026-01-01T00:00:00.000Z",
    grant: {},
  },
  {
    specVersion: "1.0.0",
    id: "ftest:b",
    type: "hackathon",
    title: "Beta hackathon weekend",
    description: "A weekend build competition.",
    status: "open",
    organization: { name: "Org B", slug: "org-b" },
    source: { url: "https://example.com/b", ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    networks: ["base"],
    categories: ["Gaming"],
    tags: ["irl"],
    funding: { totalBudget: 200000, currency: "USD" }, // only a budget, no min/max
    closesAt: "2026-06-01T00:00:00.000Z",
    hackathon: {},
  },
  {
    specVersion: "1.0.0",
    id: "ftest:c",
    type: "bounty",
    title: "Gamma bounty",
    description: "A small task.",
    status: "closed",
    organization: { name: "Org A", slug: "org-a" },
    source: { url: "https://example.com/c", ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    funding: { minAward: 50, currency: "USD" }, // only a min
    closesAt: "2026-03-01T00:00:00.000Z",
    bounty: { reward: { amount: 50, currency: "USD" } },
  },
  {
    specVersion: "1.0.0",
    id: "ftest:d",
    type: "grant",
    title: "Delta tiny grant",
    description: "Micro grants.",
    status: "open",
    organization: { name: "Org C", slug: "org-c" },
    source: { url: "https://example.com/d", ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    funding: { maxAward: 10, currency: "USD" }, // only a max — the single-bound regression case
    closesAt: "2026-09-01T00:00:00.000Z",
    grant: {},
  },
];

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("/v1/opportunities filters, sort & pagination", () => {
  let app: FastifyInstance;

  /** Query within the FILTERTEST partition; returns total + the set of ids + ordered id list. */
  async function query(qs: string) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/opportunities?ecosystem=${TAG}&${qs}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return {
      total: body.total as number,
      ids: new Set((body.items as Opportunity[]).map((o) => o.id)),
      order: (body.items as Opportunity[]).map((o) => o.id),
      body,
    };
  }

  beforeAll(async () => {
    const ctl = new OpportunityController();
    for (const f of FIXTURES) {
      await ctl.upsertFromStandard(f, { reviewStatus: "approved", isListed: true });
    }
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "ftest:%"));
    await db.delete(organizations).where(inArray(organizations.slug, ["org-a", "org-b", "org-c"]));
    await app.close();
    await pool.end();
  });

  it("baseline: all four fixtures visible", async () => {
    expect((await query("limit=50")).total).toBe(4);
  });

  it("type filter", async () => {
    expect((await query("type=grant")).ids).toEqual(new Set(["ftest:a", "ftest:d"]));
  });

  it("status filter", async () => {
    expect((await query("status=closed")).ids).toEqual(new Set(["ftest:c"]));
  });

  it("network / category / tag filters (array containment)", async () => {
    expect((await query("network=optimism")).ids).toEqual(new Set(["ftest:a"]));
    expect((await query("category=DeFi")).ids).toEqual(new Set(["ftest:a"]));
    expect((await query("tag=retro")).ids).toEqual(new Set(["ftest:a"]));
  });

  it("organization slug filter", async () => {
    expect((await query("organization=org-a")).ids).toEqual(new Set(["ftest:a", "ftest:c"]));
  });

  it("q search over title/description", async () => {
    expect((await query("q=hackathon")).ids).toEqual(new Set(["ftest:b"]));
  });

  it("minAward matches rows via max/budget/min fallbacks", async () => {
    // a(max 5000), b(budget 200000) qualify; c(min 50), d(max 10) do not
    expect((await query("minAward=1000")).ids).toEqual(new Set(["ftest:a", "ftest:b"]));
  });

  it("maxAward includes rows that set only one bound (single-bound regression)", async () => {
    // c(min 50) and d(max-only 10) qualify; a(min 1000), b(budget 200000) do not
    expect((await query("maxAward=100")).ids).toEqual(new Set(["ftest:c", "ftest:d"]));
  });

  it("sort + order actually reorder the results", async () => {
    const asc = await query("sort=closesAt&order=asc&limit=50");
    const desc = await query("sort=closesAt&order=desc&limit=50");
    expect(asc.order[0]).toBe("ftest:a"); // earliest closesAt
    expect(desc.order[0]).toBe("ftest:d"); // latest closesAt
    expect(asc.order).toEqual([...desc.order].reverse());
  });

  it("pagination: limit, totalPages, and an empty overflow page", async () => {
    const p1 = await query("limit=2&page=1");
    expect(p1.total).toBe(4);
    expect(p1.body.totalPages).toBe(2);
    expect(p1.order).toHaveLength(2);
    const p3 = await query("limit=2&page=3");
    expect(p3.order).toHaveLength(0);
    expect(p3.total).toBe(4);
  });
});
