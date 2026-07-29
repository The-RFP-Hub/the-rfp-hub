/**
 * Input-contract tests for GET /v1/opportunities: the querystring schema must REJECT what it does
 * not accept instead of silently ignoring it (unknown params were stripped by ajv's
 * `removeAdditional`; out-of-enum fundingType/status values were whitelisted away by the parser,
 * so a typo returned the full dataset with 200).
 *
 * Gated on DATABASE_URL like the other integration suites (the 200 cases run the real query path);
 * seeds its own isolated fixtures (ecosystem "QCTEST", ids "qctest:*") and cleans them up, so the
 * row counts it asserts are unaffected by whatever else is in the database.
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

const run = describeWithDb;

const TAG = "QCTEST";
const FUNDING_TYPES = ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"];
const STATUSES = ["upcoming", "open", "closed", "archived"];

const fixture = (
  over: Partial<Opportunity> & Pick<Opportunity, "id" | "fundingType" | "fundingDetails">,
): Opportunity => ({
  specVersion: "1.0.0",
  title: `Query-contract fixture ${over.id}`,
  description: "Input-contract fixture.",
  status: "open",
  operatingOrganizations: [{ name: "QC Org", slug: "qctest-org" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: [TAG],
  ...over,
});

run("GET /v1/opportunities input contract", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const service = new OpportunityService();
    for (const record of [
      fixture({
        id: "qctest:grant",
        fundingType: "grant",
        fundingDetails: { fundingType: "grant" },
        categories: ["qc-a"],
      }),
      fixture({
        id: "qctest:rfp",
        fundingType: "rfp",
        fundingDetails: { fundingType: "rfp" },
        categories: ["qc-b"],
      }),
    ]) {
      await service.upsertFromStandard(record, { reviewStatus: "approved", isListed: true });
    }
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "qctest:%"));
    await db.delete(organizations).where(inArray(organizations.slug, ["qctest-org"]));
    await app.close();
    await pool.end();
  });

  const get = (url: string) => app.inject({ method: "GET", url });

  /** 400 + the standard error envelope, never a 200 that quietly ignored the parameter. */
  async function expectBadRequest(url: string) {
    const res = await get(url);
    expect(res.statusCode, url).toBe(400);
    const body = res.json();
    expect(body.error, url).toBe("bad_request");
    expect(typeof body.message, url).toBe("string");
  }

  it("400s on an unknown query param instead of stripping it", async () => {
    for (const url of [
      "/v1/opportunities?bogusParam=1",
      "/v1/opportunities?ecosystem=X&bogusParam=1",
      "/v1/opportunities?fundingtype=grant", // wrong case is a different (unknown) param
    ]) {
      await expectBadRequest(url);
    }
  });

  it("400s on the removed pre-re-cut `type` param", async () => {
    await expectBadRequest("/v1/opportunities?type=grant");
  });

  it("400s on an out-of-enum fundingType or status, alone or inside a comma list", async () => {
    for (const url of [
      "/v1/opportunities?fundingType=grants",
      "/v1/opportunities?fundingType=grant,bogus",
      "/v1/opportunities?fundingType=bogus,grant",
      "/v1/opportunities?status=opened",
      "/v1/opportunities?status=open,nope",
    ]) {
      await expectBadRequest(url);
    }
  });

  it("400s on an out-of-enum value in a repeated occurrence", async () => {
    await expectBadRequest("/v1/opportunities?fundingType=grant&fundingType=bogus");
    await expectBadRequest("/v1/opportunities?status=open&status=nope");
  });

  it("accepts every valid fundingType and status value", async () => {
    for (const value of FUNDING_TYPES) {
      const res = await get(`/v1/opportunities?fundingType=${value}`);
      expect(res.statusCode, value).toBe(200);
      expect(Array.isArray(res.json().items), value).toBe(true);
    }
    for (const value of STATUSES) {
      const res = await get(`/v1/opportunities?status=${value}`);
      expect(res.statusCode, value).toBe(200);
    }
    // and the whole set as one comma list
    expect((await get(`/v1/opportunities?fundingType=${FUNDING_TYPES.join(",")}`)).statusCode).toBe(
      200,
    );
    expect((await get(`/v1/opportunities?status=${STATUSES.join(",")}`)).statusCode).toBe(200);
  });

  // Query builders, HTML forms and dashboard filter UIs emit every key with the unselected ones
  // blank. `ecosystem`/`category`/`q` always accepted that; fundingType/status must not be the one
  // pair that 400s, or the same request passes or fails depending on which filter the user left
  // empty.
  it("ignores an empty value on every list filter instead of 400ing", async () => {
    const blank = "fundingType=&status=&ecosystem=&category=&organization=&q=";
    const all = await get(`/v1/opportunities?${blank}`);
    expect(all.statusCode, blank).toBe(200);

    // Sending every key blank must return exactly what sending none of them returns. Compared
    // INSIDE this suite's own ecosystem partition: the sibling integration suites insert and
    // delete their fixtures in the same database concurrently, so two unpartitioned totals read
    // one after the other are a race, not an equivalence.
    const blankInPartition = await get(
      `/v1/opportunities?ecosystem=${TAG}&fundingType=&status=&ecosystem=&category=&organization=&q=`,
    );
    expect(blankInPartition.statusCode).toBe(200);
    const partition = await get(`/v1/opportunities?ecosystem=${TAG}`);
    expect(blankInPartition.json().total).toBe(partition.json().total);
    expect(partition.json().total, "the suite's own two fixtures").toBe(2);

    for (const url of [
      "/v1/opportunities?fundingType=",
      "/v1/opportunities?status=",
      `/v1/opportunities?ecosystem=${TAG}&fundingType=`,
      `/v1/opportunities?ecosystem=${TAG}&status=&fundingType=grant`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
    // an empty value alongside a real one still filters on the real one
    const narrowed = await get(`/v1/opportunities?ecosystem=${TAG}&fundingType=rfp&status=`);
    expect(narrowed.json().total).toBe(1);
  });

  it("accepts repeated, comma-separated and mixed list params equivalently", async () => {
    const equivalents = [
      `/v1/opportunities?ecosystem=${TAG}&fundingType=grant,rfp`,
      `/v1/opportunities?ecosystem=${TAG}&fundingType=grant&fundingType=rfp`,
      `/v1/opportunities?ecosystem=${TAG}&fundingType=grant,rfp&fundingType=rfp`,
    ];
    for (const url of equivalents) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      // both fixtures — the comma list, the repeated form and the two mixed OR together
      expect(res.json().total, url).toBe(2);
    }
    // and a single value still narrows
    const one = await get(`/v1/opportunities?ecosystem=${TAG}&fundingType=rfp`);
    expect(one.json().total).toBe(1);
    expect(one.json().items[0].id).toBe("qctest:rfp");

    // repeated free-text lists OR together as well
    const categories = await get(`/v1/opportunities?ecosystem=${TAG}&category=qc-a&category=qc-b`);
    expect(categories.statusCode).toBe(200);
    expect(categories.json().total).toBe(2);

    // free-text lists take the repeated form too (they used to 400 on it)
    for (const url of [
      "/v1/opportunities?ecosystem=Optimism&ecosystem=Base",
      "/v1/opportunities?category=DeFi&category=Gaming",
    ]) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
  });

  it("serves the collection at the documented no-slash path (a trailing slash still resolves)", async () => {
    for (const url of ["/v1/opportunities", "/v1/opportunities/"]) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
    expect((await get("/v1/opportunities/schema")).statusCode).toBe(200);
    // the spec publishes the no-slash form only
    const doc = (await get("/v1/docs/json")).json();
    expect(Object.keys(doc.paths)).toContain("/v1/opportunities");
    expect(Object.keys(doc.paths)).not.toContain("/v1/opportunities/");
  });
});
