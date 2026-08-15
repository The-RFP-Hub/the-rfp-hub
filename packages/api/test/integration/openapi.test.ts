/**
 * Published contract test that runs against the LIVE spec: boots the app, fetches the OpenAPI 3.1
 * document served at /v1/docs/json, and validates ACTUAL responses from every endpoint against the
 * response schema each operation DECLARES in that live document (ajv, draft 2020-12).
 * Gated on DATABASE_URL; seeds one isolated fixture for the list/detail endpoints and cleans up.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { canonicalDocuments } from "../../src/modules/shared/canonical-documents.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;
const OAS_ID = "https://rfphub.local/openapi.json";

const FIXTURE: Opportunity = {
  specVersion: "1.0.0",
  id: "otest:1",
  fundingType: "grant",
  title: "OpenAPI fixture",
  description: "d",
  status: "open",
  operatingOrganizations: [{ name: "OAS Org", slug: "oas-org" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: ["OASTEST"],
  deadlines: [{ deadlineType: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" }],
  fundingDetails: { fundingType: "grant" },
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

  /**
   * The `$ref` an operation declares for its 200 response, rebased onto the bundle. Operations
   * declare exactly one media type — `application/json` for most, `application/schema+json` for
   * the schema route — so the single content entry is taken rather than a hard-coded key.
   */
  function response200Ref(pathKey: string): string {
    const content = doc.paths[pathKey].get.responses["200"].content;
    const mediaTypes = Object.keys(content);
    expect(mediaTypes).toHaveLength(1);
    const ref = content[mediaTypes[0] as string].schema.$ref;
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
      "/v1/opportunities",
      "/v1/opportunities/{id}",
      "/v1/opportunities/schema",
      "/v1/stats",
      "/v1/health",
      "/v1/publishers",
      "/v1/opportunities/{id}/audit",
      "/v1/opportunities/{id}/duplicates",
      "/v1/opportunities/{id}/verification",
      // The spec's own documents, at the paths their identifiers name (adr/0007).
      ...canonicalDocuments.map((d) => d.path),
    ]) {
      expect(doc.paths?.[path]?.get, `documents GET ${path}`).toBeTruthy();
    }
    for (const name of [
      "Opportunity",
      "OpportunitySummary",
      "PaginatedOpportunities",
      "Stats",
      "SchemaResponse",
      "JsonLdContext",
      "SpecVersionIndex",
      "Health",
      // M3
      "SubmissionResult",
      "ValidationErrorResponse",
      "AuditTrail",
      "ClaimResult",
      "Publisher",
      "Me",
      "ApiKey",
      "ApiKeyCreated",
      "ManagedOpportunityList",
    ]) {
      expect(doc.components?.schemas?.[name], `components has ${name}`).toBeTruthy();
    }

    // The write, review and admin operations are published, and they declare the credential they
    // need — an undocumented authenticated endpoint is worse than none.
    for (const [path, method] of [
      ["/v1/opportunities", "post"],
      ["/v1/opportunities/{id}", "put"],
      ["/v1/opportunities/{id}/claim", "post"],
      ["/v1/me", "get"],
      ["/v1/keys", "post"],
      ["/v1/review/opportunities", "get"],
      ["/v1/admin/accounts/{id}/role", "post"],
    ] as const) {
      const op = doc.paths?.[path]?.[method];
      expect(op, `documents ${method.toUpperCase()} ${path}`).toBeTruthy();
      expect(op.security, `${method.toUpperCase()} ${path} declares its credential`).toEqual([
        { bearerAuth: [] },
      ]);
    }
    expect(doc.components?.securitySchemes?.bearerAuth?.scheme).toBe("bearer");
    // The public list of verified publishers carries no security requirement at all.
    expect(doc.paths["/v1/publishers"].get.security).toBeUndefined();
    // the error contract is published, too
    expect(doc.paths["/v1/opportunities"].get.responses["400"]).toBeTruthy();
    expect(doc.paths["/v1/opportunities/{id}"].get.responses["404"]).toBeTruthy();
    // no trailing-slash paths, and every operation carries a unique operationId
    const operationIds: string[] = [];
    for (const [path, ops] of Object.entries<Record<string, { operationId?: string }>>(doc.paths)) {
      if (path !== "/") expect(path, `${path} has no trailing slash`).not.toMatch(/\/$/);
      for (const [method, op] of Object.entries(ops)) {
        expect(op.operationId, `GET-level operationId on ${method} ${path}`).toBeTruthy();
        operationIds.push(op.operationId as string);
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
    // and the info block declares the package's MIT license
    expect(doc.info.license).toEqual({ name: "MIT", identifier: "MIT" });
  });

  it("publishes collection paths in the documented no-slash form", () => {
    const collections = Object.keys(doc.paths).filter((p: string) => p !== "/" && p.endsWith("/"));
    expect(collections, "no published path carries a trailing slash").toEqual([]);
  });

  it("publishes the re-cut filter surface, with the rolling-only exclusion documented", () => {
    const params: { name: string; description?: string; schema?: Record<string, unknown> }[] =
      doc.paths["/v1/opportunities"].get.parameters;
    const byName = new Map(params.map((p) => [p.name, p]));

    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(["fundingType", "deadlineAfter", "deadlineBefore", "organization"]),
    );
    expect(byName.has("type")).toBe(false); // renamed to fundingType

    for (const name of ["deadlineAfter", "deadlineBefore", "sort"]) {
      expect(byName.get(name)?.description, `${name} documents the rolling exclusion`).toMatch(
        /rolling-only/i,
      );
    }
    expect(byName.get("organization")?.description).toMatch(/ANY entry/);

    const sortEnum = byName.get("sort")?.schema?.enum as string[];
    expect(sortEnum).toContain("nextDeadlineAt");
    expect(sortEnum).not.toContain("closesAt");
    expect(byName.get("sort")?.schema?.default).toBe("nextDeadlineAt");
  });

  it("publishes the accepted values of the enum filters and the repeatable list form", () => {
    const params: { name: string; description?: string; schema?: Record<string, unknown> }[] =
      doc.paths["/v1/opportunities"].get.parameters;
    const byName = new Map(params.map((p) => [p.name, p]));

    for (const [name, values] of [
      ["fundingType", ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"]],
      ["status", ["upcoming", "open", "closed", "archived"]],
    ] as const) {
      const param = byName.get(name);
      // list params are arrays (repeatable); the comma-list pattern is what documents the values
      expect(param?.schema?.type, `${name} is a repeatable list`).toBe("array");
      const pattern = (param?.schema?.items as { pattern?: string } | undefined)?.pattern;
      for (const value of values) {
        expect(pattern, `${name} pattern accepts ${value}`).toContain(value);
        expect(param?.description, `${name} description lists ${value}`).toContain(value);
      }
      expect(param?.description).toMatch(/comma-separate/i);
    }

    for (const name of ["ecosystem", "category"]) {
      expect(byName.get(name)?.schema?.type, `${name} is a repeatable list`).toBe("array");
      expect(byName.get(name)?.description).toMatch(/Repeat the parameter/i);
    }
  });

  it("declares the Opportunity component in the re-cut shape", () => {
    const opportunity = doc.components.schemas.Opportunity;
    expect(opportunity.required).toEqual(
      expect.arrayContaining(["fundingType", "operatingOrganizations", "fundingDetails"]),
    );
    expect(opportunity.required).not.toContain("type");
    expect(opportunity.required).not.toContain("organization");
    expect(opportunity.required).not.toContain("sponsoringOrganizations"); // optional now
    expect(opportunity.properties.deadlines).toBeTruthy();
    expect(opportunity.properties.closesAt).toBeUndefined();
  });

  // `servers[0].url` is driven by PUBLIC_BASE_URL and defaults to the relative "/" — correct
  // wherever the server is reachable, and never carrying a trailing slash that would make every
  // operation resolve to "//v1/…". config.ts is what enforces the shape; this is the wiring.
  it("advertises the configured base URL as its single server entry", () => {
    expect(doc.servers).toEqual([{ url: config.publicBaseUrl }]);
    expect(doc.servers[0].url === "/" || !doc.servers[0].url.endsWith("/")).toBe(true);
  });

  it("publishes detail (Opportunity) and list (OpportunitySummary) as distinct components", () => {
    const detail = doc.components.schemas.Opportunity;
    const summary = doc.components.schemas.OpportunitySummary;
    const fundingTypes = ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"];

    // the detail object carries the single fundingDetails slot; the thin projection omits it,
    // and neither declares the six pre-fundingDetails per-type block properties
    expect(detail.properties.fundingDetails, "Opportunity declares fundingDetails").toBeTruthy();
    expect(
      summary.properties.fundingDetails,
      "OpportunitySummary omits fundingDetails",
    ).toBeUndefined();
    for (const block of fundingTypes) {
      expect(detail.properties[block], `Opportunity has no legacy ${block} block`).toBeUndefined();
      expect(summary.properties[block], `OpportunitySummary omits ${block}`).toBeUndefined();
    }
    // everything else is shared — including the fields the served object carries beyond the core
    for (const field of [
      "website",
      "logoUrl",
      "bannerUrl",
      "socialLinks",
      "postedAt",
      "updatedAt",
    ]) {
      expect(detail.properties[field], `Opportunity declares ${field}`).toBeTruthy();
      expect(summary.properties[field], `OpportunitySummary declares ${field}`).toBeTruthy();
    }
    // the summary requires everything the detail does EXCEPT the omitted fundingDetails slot
    expect(detail.required).toContain("fundingDetails");
    expect(summary.required).toEqual(
      detail.required.filter((name: string) => name !== "fundingDetails"),
    );
    // enums are the Standard's, not a hand-kept copy (test/unit/openapi-drift.test.ts diffs them)
    expect(detail.properties.fundingType.enum).toEqual(fundingTypes);
    expect(detail.properties.status.enum).toEqual(["upcoming", "open", "closed", "archived"]);
  });

  it("routes the list through OpportunitySummary and the detail through Opportunity", async () => {
    expect(response200Ref("/v1/opportunities")).toBe(
      `${OAS_ID}#/components/schemas/PaginatedOpportunities`,
    );
    expect(doc.components.schemas.PaginatedOpportunities.properties.items.items.$ref).toBe(
      "#/components/schemas/OpportunitySummary",
    );
    expect(response200Ref("/v1/opportunities/{id}")).toBe(
      `${OAS_ID}#/components/schemas/Opportunity`,
    );

    // and the split is real, not merely declared: the list drops fundingDetails, the detail keeps it
    const list = await app.inject({
      method: "GET",
      url: "/v1/opportunities?ecosystem=OASTEST&limit=5",
    });
    expect(list.json().items[0].fundingDetails).toBeUndefined();
    const one = await app.inject({ method: "GET", url: "/v1/opportunities/otest:1" });
    expect(one.json().fundingDetails).toEqual({ fundingType: "grant" });
  });

  it("GET /v1/opportunities conforms to its declared 200 schema", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/opportunities?ecosystem=OASTEST&limit=5",
    });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/opportunities", res.json());
  });

  it("GET /v1/opportunities/:id conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/otest:1" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/opportunities/{id}", res.json());
  });

  it("GET /v1/opportunities/schema declares and serves application/schema+json", async () => {
    expect(Object.keys(doc.paths["/v1/opportunities/schema"].get.responses["200"].content)).toEqual(
      ["application/schema+json"],
    );
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/schema" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/schema+json");
    assertConformsTo("/v1/opportunities/schema", res.json());
  });

  /**
   * The canonical spec routes. Same live-spec discipline as every other endpoint: what the
   * document declares must be what the route serves — and for these, the declared media type is
   * the interoperability contract (`application/schema+json` / `application/ld+json`), not a
   * detail. They are also the one group of operations that must NOT be under `/v1/`.
   */
  for (const canonicalDoc of canonicalDocuments) {
    it(`GET ${canonicalDoc.path} declares and serves ${canonicalDoc.mediaType}`, async () => {
      const operation = doc.paths[canonicalDoc.path].get;
      expect(operation.tags).toEqual(["spec"]);
      expect(Object.keys(operation.responses["200"].content)).toEqual([canonicalDoc.mediaType]);
      expect(operation.responses["200"].content[canonicalDoc.mediaType].schema.$ref).toBe(
        `#/components/schemas/${canonicalDoc.component}`,
      );

      const res = await app.inject({ method: "GET", url: canonicalDoc.path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain(canonicalDoc.mediaType);
      assertConformsTo(canonicalDoc.path, res.json());
    });
  }

  it("keeps the spec's identifiers out of the API's version namespace", () => {
    for (const canonicalDoc of canonicalDocuments) {
      expect(canonicalDoc.path, "an identifier must not carry an API version").not.toMatch(
        /^\/v\d+\//,
      );
    }
    // and every spec-tagged operation is one of them — nothing else claims that tag
    const tagged = Object.entries<Record<string, { tags?: string[] }>>(doc.paths)
      .filter(([, ops]) => ops.get?.tags?.includes("spec"))
      .map(([path]) => path);
    expect(tagged.sort()).toEqual(canonicalDocuments.map((d) => d.path).sort());
  });

  it("GET /v1/stats conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/stats", res.json());
  });

  it("GET /v1/health conforms to its declared 200 schema", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    assertConformsTo("/v1/health", res.json());
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
