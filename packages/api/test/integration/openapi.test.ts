import type { Opportunity } from "@rfp-hub/standard";
import addFormats from "ajv-formats";
/**
 * DEV-446 "published test suite that runs against the live spec": boots the app, fetches the
 * OpenAPI 3.1 document served at /v1/docs/json, and validates ACTUAL responses from every endpoint
 * against the response schema each operation DECLARES in that live document (ajv, draft 2020-12).
 * Gated on DATABASE_URL; seeds one isolated fixture for the list/detail endpoints and cleans up.
 */
import Ajv2020 from "ajv/dist/2020.js";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunity.service.js";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const OAS_ID = "https://rfphub.local/openapi.json";

const FIXTURE: Opportunity = {
  specVersion: "1.0.0",
  id: "otest:1",
  type: "grant",
  title: "OpenAPI fixture",
  description: "d",
  status: "open",
  organization: { name: "OAS Org", slug: "oas-org" },
  source: { url: "https://example.com/oas-1", ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: ["OASTEST"],
  grant: {},
};

/** Deep-copy the served components, dropping any nested `$id` (which would hijack pointer refs). */
function componentsForAjv(
  schemas: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== "$id") copy[k] = v;
    out[name] = copy;
  }
  return out;
}

run("OpenAPI 3.1 live-spec contract", () => {
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: the served OpenAPI document is dynamic JSON
  let doc: any;
  let ajv: Ajv2020;

  /** The `$ref` an operation declares for its 200 JSON response, rebased onto the bundle. */
  function response200Ref(pathKey: string): string {
    const ref = doc.paths[pathKey].get.responses["200"].content["application/json"].schema.$ref;
    expect(typeof ref).toBe("string"); // e.g. "#/components/schemas/Stats"
    return OAS_ID + ref;
  }

  /** Validate a live response body against the schema its operation declares in the served doc. */
  function assertConformsTo(pathKey: string, body: unknown) {
    const validate = ajv.compile({ $ref: response200Ref(pathKey) });
    if (!validate(body)) {
      throw new Error(
        `${pathKey} response violated the live spec: ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(validate(body)).toBe(true);
  }

  beforeAll(async () => {
    const ctl = new OpportunityService();
    await ctl.upsertFromStandard(FIXTURE, { reviewStatus: "approved", isListed: true });
    app = await buildApp();
    await app.ready();

    doc = (await app.inject({ method: "GET", url: "/v1/docs/json" })).json();
    ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
    addFormats(ajv);
    // Register the components the live doc serves so the operations' response $refs — and their
    // internal `#/components/schemas/...` cross-refs — resolve during validation.
    ajv.addSchema({
      $id: OAS_ID,
      components: { schemas: componentsForAjv(doc.components.schemas) },
    });
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "otest:%"));
    await db.delete(organizations).where(eq(organizations.slug, "oas-org"));
    await app.close();
    await pool.end();
  });

  it("serves a valid OpenAPI 3.1 document with the expected operations + named components", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.title).toBeTruthy();
    for (const path of [
      "/v1/opportunities/",
      "/v1/opportunities/{id}",
      "/v1/opportunities/schema",
      "/v1/stats/",
      "/v1/health/",
    ]) {
      expect(doc.paths?.[path]?.get, `documents GET ${path}`).toBeTruthy();
    }
    for (const name of [
      "Opportunity",
      "PaginatedOpportunities",
      "Stats",
      "SchemaResponse",
      "Health",
    ]) {
      expect(doc.components?.schemas?.[name], `components has ${name}`).toBeTruthy();
    }
    // the error contract is published, too
    expect(doc.paths["/v1/opportunities/"].get.responses["400"]).toBeTruthy();
    expect(doc.paths["/v1/opportunities/{id}"].get.responses["404"]).toBeTruthy();
  });

  it("GET /v1/opportunities conforms to its declared 200 schema", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/opportunities?ecosystem=OASTEST&limit=5",
    });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/opportunities/", res.json());
  });

  it("GET /v1/opportunities/:id conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/otest:1" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/opportunities/{id}", res.json());
  });

  it("GET /v1/opportunities/schema conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/schema" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/opportunities/schema", res.json());
  });

  it("GET /v1/stats conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/stats/", res.json());
  });

  it("GET /v1/health conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/health/", res.json());
  });

  it("honors the documented 400 (bad param) and 404 (missing) contracts", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/v1/opportunities?sort=nope" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/v1/opportunities/otest:missing" })).statusCode,
    ).toBe(404);
  });
});
