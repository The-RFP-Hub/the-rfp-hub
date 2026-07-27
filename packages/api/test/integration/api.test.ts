/**
 * Endpoint integration tests via app.inject() against a real Postgres (gated on DATABASE_URL).
 * Seeds its own isolated fixtures (ecosystem "TESTONLY") and cleans them up, so it's deterministic
 * regardless of whatever else is in the database.
 */
import { type Opportunity, opportunitySchema } from "@the-rfp-hub/standard";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";

const TAG = "TESTONLY";

const fixture = (
  over: Partial<Opportunity> & Pick<Opportunity, "id" | "fundingType">,
): Opportunity => ({
  specVersion: "1.0.0",
  title: `Fixture ${over.id}`,
  description: "Integration fixture.",
  status: "open",
  sponsoringOrganizations: [{ name: "Test Org", slug: "test-org" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: [TAG],
  ...over,
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("/v1 API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctl = new OpportunityService();
    await ctl.upsertFromStandard(
      fixture({ id: "itest:grant-1", fundingType: "grant", grant: {} }),
      { reviewStatus: "approved", isListed: true },
    );
    await ctl.upsertFromStandard(
      fixture({
        id: "itest:hack-1",
        fundingType: "hackathon",
        hackathon: { online: true, prizes: [{ amount: 1000, currency: "USD" }] },
        operatingOrganizations: [{ name: "Operator Ltd", slug: "test-operator" }],
        eligibility: { geography: "Global" },
        milestones: [{ title: "Demo day", criteria: "Ship something" }],
        deadlines: [{ type: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" }],
      }),
      { reviewStatus: "approved", isListed: true },
    );
    await ctl.upsertFromStandard(fixture({ id: "itest:hidden", fundingType: "grant", grant: {} }), {
      reviewStatus: "approved",
      isListed: false,
    });
    await ctl.upsertFromStandard(
      fixture({ id: "itest:pending", fundingType: "grant", grant: {} }),
      {
        reviewStatus: "pending",
        isListed: true,
      },
    );

    app = await buildApp();
    app.get("/__boom__", async () => {
      throw new Error("pg: password authentication failed for user secret");
    });
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "itest:%"));
    await db
      .delete(organizations)
      .where(inArray(organizations.slug, ["test-org", "test-operator"]));
    await app.close();
    await pool.end();
  });

  it("GET /v1/health → ok", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /v1/opportunities returns only approved+listed, thin projection, with pagination", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/opportunities?ecosystem=${TAG}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2); // hidden + pending excluded
    expect(new Set(body.items.map((o: Opportunity) => o.id))).toEqual(
      new Set(["itest:grant-1", "itest:hack-1"]),
    );
    expect(body).toMatchObject({ page: 1, limit: 20, totalPages: 1 });
    // thin: no type-specific block in list items
    for (const item of body.items) expect(item[item.fundingType]).toBeUndefined();
  });

  it("honors the fundingType filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/opportunities?ecosystem=${TAG}&fundingType=hackathon`,
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe("itest:hack-1");
  });

  it("GET /v1/opportunities/:id returns the full object with its type block", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/itest:hack-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.specVersion).toBe("1.0.0");
    expect(body.fundingType).toBe("hackathon");
    expect(body.hackathon).toMatchObject({ online: true });
    expect(body.sponsoringOrganizations[0].name).toBe("Test Org");
    expect(body.operatingOrganizations[0].slug).toBe("test-operator");
    expect(body.eligibility).toEqual({ geography: "Global" });
    expect(body.milestones).toHaveLength(1);
    expect(body.deadlines).toEqual([
      { type: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" },
    ]);
    // removed by the re-cut — must not reappear
    expect(body).not.toHaveProperty("type");
    expect(body).not.toHaveProperty("organization");
    expect(body).not.toHaveProperty("closesAt");
    expect(body.source).not.toHaveProperty("url");
  });

  it("404s for missing, unlisted, and pending entries", async () => {
    for (const id of ["itest:nope", "itest:hidden", "itest:pending"]) {
      const res = await app.inject({ method: "GET", url: `/v1/opportunities/${id}` });
      expect(res.statusCode).toBe(404);
    }
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/itest:nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "not_found",
      message: "opportunity 'itest:nope' not found",
    });
  });

  it("400s on an invalid sort value (including the removed closesAt)", async () => {
    for (const sort of ["bogus", "closesAt"]) {
      const res = await app.inject({ method: "GET", url: `/v1/opportunities?sort=${sort}` });
      expect(res.statusCode, sort).toBe(400);
      const body = res.json();
      expect(body.error).toBe("bad_request");
      expect(typeof body.message).toBe("string");
    }
  });

  it("400s on a malformed deadline window bound", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/opportunities?deadlineAfter=yesterday",
    });
    expect(res.statusCode).toBe(400);
  });

  it("normalizes unknown-route 404s to the canonical shape", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("returns a generic 500 without leaking internals", async () => {
    const res = await app.inject({ method: "GET", url: "/__boom__" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "internal server error" });
    expect(res.body).not.toContain("password");
  });

  it("GET /v1/opportunities/schema serves the Standard as application/schema+json", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/schema" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/schema+json");
    const doc = res.json();
    // $id is stamped from packages/standard/spec.config.json — assert the route serves what
    // the standard package ships, not a hardcoded URL that would need a second edit.
    expect(doc.$id).toBe((opportunitySchema as Record<string, unknown>).$id);
    expect(doc.title).toBe("RFP Hub Opportunity");
    // it is the NEW schema: fundingType/sponsoringOrganizations in, type/organization/closesAt out
    expect(doc.required).toContain("fundingType");
    expect(doc.required).toContain("sponsoringOrganizations");
    expect(doc.properties.deadlines).toBeTruthy();
    expect(doc.properties.type).toBeUndefined();
    expect(doc.properties.organization).toBeUndefined();
    expect(doc.properties.closesAt).toBeUndefined();
  });

  it("GET /v1/stats returns numeric breakdowns + a valid lastUpdatedAt", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    // fixtures include a grant + a hackathon
    expect(body.byFundingType.grant).toBeGreaterThanOrEqual(1);
    expect(body.byFundingType.hackathon).toBeGreaterThanOrEqual(1);
    expect(body).not.toHaveProperty("byType");
    expect(Object.values(body.byStatus).every((v) => typeof v === "number")).toBe(true);
    // topEcosystems comes from the raw unnest(ecosystems) aggregation
    expect(Array.isArray(body.topEcosystems)).toBe(true);
    expect(body.topEcosystems.length).toBeGreaterThan(0);
    expect(typeof body.topEcosystems[0].ecosystem).toBe("string");
    expect(typeof body.topEcosystems[0].count).toBe("number");
    expect(Number.isNaN(Date.parse(body.lastUpdatedAt))).toBe(false);
  });

  it("rejects at ingest a record carrying a block that does not match its fundingType", async () => {
    const ctl = new OpportunityService();
    const twoBlocks = fixture({
      id: "itest:two-blocks",
      fundingType: "grant",
      grant: {},
      hackathon: { online: true },
    });
    await expect(ctl.upsertFromStandard(twoBlocks)).rejects.toThrow(/also carries: hackathon/);
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/itest:two-blocks" });
    expect(res.statusCode).toBe(404); // nothing was stored
  });
});
