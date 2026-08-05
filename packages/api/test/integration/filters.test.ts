/**
 * Exercises every documented /v1/opportunities query param + sort + pagination against real
 * Postgres, with isolated self-cleaning fixtures (ecosystem "FILTERTEST", ids "ftest:*").
 * Gated on DATABASE_URL. This is the "honor every documented query param" coverage.
 *
 * Deadline coverage is deliberate: the re-cut replaced the sortable `closesAt` scalar with
 * `deadlines[]`, so the fixtures below cover all four derivation cases for `nextDeadlineAt` —
 * a future fixed date, a past-only fixed date, rolling-only, and none at all — and assert that
 * the last three sort LAST and are excluded from the deadline-window filters.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { describeWithDb } from "./db-gate.js";

const TAG = "FILTERTEST";
const ORG_SLUGS = ["org-a", "org-b", "org-c", "org-d", "org-e", "org-op"];

const FIXTURES: Opportunity[] = [
  {
    specVersion: "1.0.0",
    id: "ftest:a",
    fundingType: "grant",
    title: "Alpha DeFi grant",
    description: "Grants for DeFi builders.",
    status: "open",
    // OPERATING-only — no sponsors at all (sponsoringOrganizations is optional now).
    operatingOrganizations: [{ name: "Org A", slug: "org-a" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG, "Optimism"],
    categories: ["DeFi"],
    fundingInfo: { minAward: 1000, maxAward: 5000, currency: "USD" },
    deadlines: [{ deadlineType: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" }],
    fundingDetails: { fundingType: "grant" },
  },
  {
    specVersion: "1.0.0",
    id: "ftest:b",
    fundingType: "hackathon",
    title: "Beta hackathon weekend",
    description: "A weekend build competition.",
    status: "open",
    // Distinct operator and sponsor — the `organization` filter must match EITHER role.
    operatingOrganizations: [{ name: "Org Op", slug: "org-op" }],
    sponsoringOrganizations: [{ name: "Org B", slug: "org-b" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    categories: ["Gaming"],
    fundingInfo: { budget: 200000, currency: "USD" }, // only a budget, no min/max
    deadlines: [
      { deadlineType: "fixed", date: "2999-06-01T00:00:00.000Z", label: "application" },
      { deadlineType: "fixed", date: "2000-01-01T00:00:00.000Z", label: "event start" }, // past: ignored
    ],
    fundingDetails: { fundingType: "hackathon" },
  },
  {
    // TWO sponsors — the `organization` filter must match either, not just the first one.
    specVersion: "1.0.0",
    id: "ftest:c",
    fundingType: "bounty",
    title: "Gamma bounty",
    description: "A small task.",
    status: "closed",
    operatingOrganizations: [{ name: "Org D", slug: "org-d" }],
    sponsoringOrganizations: [
      { name: "Org D", slug: "org-d" },
      { name: "Org A", slug: "org-a" },
    ],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    fundingInfo: { minAward: 50, currency: "USD" }, // only a min
    deadlines: [{ deadlineType: "fixed", date: "2999-03-01T00:00:00.000Z", label: "application" }],
    fundingDetails: { fundingType: "bounty", reward: { amount: 50, currency: "USD" } },
  },
  {
    // ROLLING-ONLY → nextDeadlineAt is null: sorts last, excluded from deadline windows.
    specVersion: "1.0.0",
    id: "ftest:d",
    fundingType: "grant",
    title: "Delta tiny grant",
    description: "Micro grants, always open.",
    status: "open",
    operatingOrganizations: [{ name: "Org C", slug: "org-c" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    fundingInfo: { maxAward: 10, currency: "USD" }, // only a max — the single-bound regression case
    deadlines: [{ deadlineType: "rolling", label: "application" }],
    fundingDetails: { fundingType: "grant" },
  },
  {
    // PAST-ONLY fixed deadline → nextDeadlineAt is null as well.
    specVersion: "1.0.0",
    id: "ftest:e",
    fundingType: "grant",
    title: "Epsilon expired grant",
    description: "The window has closed.",
    status: "closed",
    operatingOrganizations: [{ name: "Org E", slug: "org-e" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    deadlines: [{ deadlineType: "fixed", date: "2000-01-01T00:00:00.000Z", label: "application" }],
    fundingDetails: { fundingType: "grant" },
  },
];

const run = describeWithDb;

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
    const ctl = new OpportunityService();
    for (const f of FIXTURES) {
      await ctl.upsertFromStandard(f, { reviewStatus: "approved", isListed: true });
    }
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "ftest:%"));
    await db.delete(organizations).where(inArray(organizations.slug, ORG_SLUGS));
    await app.close();
    await pool.end();
  });

  it("baseline: all five fixtures visible", async () => {
    expect((await query("limit=50")).total).toBe(5);
  });

  it("fundingType filter", async () => {
    expect((await query("fundingType=grant")).ids).toEqual(
      new Set(["ftest:a", "ftest:d", "ftest:e"]),
    );
    expect((await query("fundingType=bounty,hackathon")).ids).toEqual(
      new Set(["ftest:b", "ftest:c"]),
    );
  });

  it("status filter", async () => {
    expect((await query("status=closed")).ids).toEqual(new Set(["ftest:c", "ftest:e"]));
  });

  it("category filter (array containment)", async () => {
    expect((await query("category=DeFi")).ids).toEqual(new Set(["ftest:a"]));
    expect((await query("category=Gaming")).ids).toEqual(new Set(["ftest:b"]));
  });

  it("organization filter matches operating AND sponsoring orgs, in any position", async () => {
    // ftest:a operates under org-a; ftest:c lists Org A as its SECOND sponsor — both must match.
    expect((await query("organization=org-a")).ids).toEqual(new Set(["ftest:a", "ftest:c"]));
    expect((await query("organization=org-d")).ids).toEqual(new Set(["ftest:c"]));
    // sponsoring-only match (org-b never operates anything)
    expect((await query("organization=org-b")).ids).toEqual(new Set(["ftest:b"]));
    // operating-only match (org-op never sponsors anything)
    expect((await query("organization=org-op")).ids).toEqual(new Set(["ftest:b"]));
  });

  it("q search over title/description", async () => {
    expect((await query("q=hackathon")).ids).toEqual(new Set(["ftest:b"]));
  });

  it("minAward matches rows via max/budget/min fallbacks", async () => {
    // a(max 5000), b(budget 200000) qualify; c(min 50), d(max 10), e(no funding) do not
    expect((await query("minAward=1000")).ids).toEqual(new Set(["ftest:a", "ftest:b"]));
  });

  it("maxAward includes rows that set only one bound (single-bound regression)", async () => {
    // c(min 50) and d(max-only 10) qualify; a(min 1000), b(budget 200000), e(none) do not
    expect((await query("maxAward=100")).ids).toEqual(new Set(["ftest:c", "ftest:d"]));
  });

  it("sorts by the derived nextDeadlineAt, with no-next-deadline rows LAST in both directions", async () => {
    const noNextDeadline = new Set(["ftest:d", "ftest:e"]); // rolling-only + past-only
    const asc = await query("sort=nextDeadlineAt&order=asc&limit=50");
    expect(asc.order.slice(0, 3)).toEqual(["ftest:a", "ftest:c", "ftest:b"]);
    expect(new Set(asc.order.slice(3))).toEqual(noNextDeadline);

    const desc = await query("sort=nextDeadlineAt&order=desc&limit=50");
    expect(desc.order.slice(0, 3)).toEqual(["ftest:b", "ftest:c", "ftest:a"]);
    expect(new Set(desc.order.slice(3))).toEqual(noNextDeadline);
  });

  it("nextDeadlineAt ignores a past deadline that sits beside a future one", async () => {
    // ftest:b carries a 2000 'event start' AND a 2999 'application' — the 2999 one wins.
    expect((await query("deadlineAfter=2999-05-01T00:00:00.000Z")).ids).toEqual(
      new Set(["ftest:b"]),
    );
  });

  it("deadline-window filters EXCLUDE rolling-only and past-only records", async () => {
    const before = await query("deadlineBefore=2999-04-01T00:00:00.000Z&limit=50");
    expect(before.ids).toEqual(new Set(["ftest:a", "ftest:c"]));

    const after = await query("deadlineAfter=2999-02-01T00:00:00.000Z&limit=50");
    expect(after.ids).toEqual(new Set(["ftest:b", "ftest:c"]));

    // an unbounded window still leaves out the two null-nextDeadlineAt rows
    const window = await query(
      "deadlineAfter=2000-01-01T00:00:00.000Z&deadlineBefore=3000-01-01T00:00:00.000Z&limit=50",
    );
    expect(window.ids).toEqual(new Set(["ftest:a", "ftest:b", "ftest:c"]));
    expect(window.ids.has("ftest:d")).toBe(false); // rolling-only
    expect(window.ids.has("ftest:e")).toBe(false); // past-only
  });

  it("serves deadlines[] back on the list projection", async () => {
    const { body } = await query("fundingType=grant&limit=50");
    const rolling = (body.items as Opportunity[]).find((o) => o.id === "ftest:d");
    expect(rolling?.deadlines).toEqual([{ deadlineType: "rolling", label: "application" }]);
  });

  it("pagination: limit, totalPages, and an empty overflow page", async () => {
    const p1 = await query("limit=2&page=1");
    expect(p1.total).toBe(5);
    expect(p1.body.totalPages).toBe(3);
    expect(p1.order).toHaveLength(2);
    const p4 = await query("limit=2&page=4");
    expect(p4.order).toHaveLength(0);
    expect(p4.total).toBe(5);
  });
});
