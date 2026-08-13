/**
 * THE SPEC'S IDENTIFIERS, ACTUALLY DEREFERENCING.
 *
 * Two artifacts land together here, both gated on the canonical domain decision (`adr/0007`,
 * `ARTIFACTS.md`):
 *
 *   1. every canonical document served at the path its own `$id` names, with the right media
 *      type and the same bytes the package ships;
 *   2. the `Link: <…context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"` advertisement
 *      on `application/json` opportunity responses.
 *
 * The tests that matter most are the negative ones. A `Link` header on the wrong response is
 * not a missing feature, it is a wrong instruction: `application/schema+json` carries the
 * `+json` suffix, so a conformant JSON-LD processor MUST follow an advertised context there and
 * would read a JSON Schema document as an RFP Hub opportunity.
 *
 * DB-gated because the opportunity endpoints need one; the document routes do not, but keeping
 * both halves in one file is what makes the "here but not there" assertions readable.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  CONTEXT_URL,
  SCHEMA_URL,
  canonicalDocuments,
  specConfig,
} from "../../src/modules/shared/canonical-documents.js";
import { JSONLD_CONTEXT_LINK, JSONLD_CONTEXT_REL } from "../../src/modules/shared/jsonld-link.js";
import { APEX_HOST } from "../../src/plugins/apex-host.js";
import { describeWithDb } from "./db-gate.js";

const here = dirname(fileURLToPath(import.meta.url));
const standardRoot = join(here, "..", "..", "..", "standard");

const FIXTURE: Opportunity = {
  specVersion: "1.0.0",
  id: "ctest:1",
  fundingType: "grant",
  title: "Canonical fixture",
  description: "d",
  status: "open",
  operatingOrganizations: [{ name: "Canon Org", slug: "canon-org" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: ["CANONTEST"],
  fundingDetails: { fundingType: "grant" },
};

describeWithDb("canonical spec documents + JSON-LD context advertisement", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await new OpportunityService().upsertFromStandard(FIXTURE, {
      reviewStatus: "approved",
      isListed: true,
    });
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "ctest:%"));
    await db.delete(organizations).where(eq(organizations.slug, "canon-org"));
    await app.close();
    await pool.end();
  });

  // ------------------------------------------------------------- the documents ---

  it("serves every document the Standard publishes an identifier for", () => {
    expect(canonicalDocuments.map((doc) => doc.path)).toEqual([
      "/schemas/v1.0.0/opportunity.schema.json",
      "/schemas/v1.0.0/context.jsonld",
      "/schemas/index.json",
      "/meta/rfphub-schema.meta.json",
      "/registries/entry.schema.json",
    ]);
  });

  // The route path is not typed out anywhere: it is the identifier's own path component. This
  // is what makes "the identifier dereferences" true by construction rather than by upkeep.
  it("derives every route path from the identifier itself", () => {
    for (const doc of canonicalDocuments) {
      expect(doc.url, doc.path).toBe(`${specConfig.baseUrl}${doc.path}`);
      expect(doc.source, doc.path).toBe(doc.path.slice(1));
    }
    expect(SCHEMA_URL).toBe(
      `${specConfig.baseUrl}/${specConfig.schemaDir}/opportunity.schema.json`,
    );
    expect(CONTEXT_URL).toBe(`${specConfig.baseUrl}/${specConfig.schemaDir}/context.jsonld`);
  });

  for (const doc of canonicalDocuments) {
    it(`GET ${doc.path} serves ${doc.mediaType}, byte-for-byte`, async () => {
      const res = await app.inject({ method: "GET", url: doc.path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain(doc.mediaType);
      // The bytes the package ships, not a re-serialization of them: a consumer that hashes
      // the served document gets the same digest as one that hashes the file.
      expect(res.rawPayload.equals(readFileSync(join(standardRoot, doc.source)))).toBe(true);
    });
  }

  it("serves documents whose $id points at the URL they are served at", async () => {
    for (const doc of canonicalDocuments.filter((d) => d.selfIdentifying)) {
      const res = await app.inject({ method: "GET", url: doc.path });
      expect(res.json().$id, doc.path).toBe(doc.url);
    }
  });

  it("serves the same schema bytes at the /v1 convenience route", async () => {
    const canonicalRes = await app.inject({
      method: "GET",
      url: "/schemas/v1.0.0/opportunity.schema.json",
    });
    const v1Res = await app.inject({ method: "GET", url: "/v1/opportunities/schema" });
    expect(v1Res.statusCode).toBe(200);
    expect(v1Res.rawPayload.equals(canonicalRes.rawPayload)).toBe(true);
    // and the $id still names the canonical URL, not this one
    expect(v1Res.json().$id).toBe(SCHEMA_URL);
  });

  it("advertises the spec paths from the service-info root", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.json().spec).toEqual(canonicalDocuments.map((doc) => doc.path));
  });

  // --------------------------------------------------- the Link advertisement ---

  it("advertises the canonical context on the opportunity list", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities?ecosystem=CANONTEST" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.link).toBe(JSONLD_CONTEXT_LINK);
    expect(res.headers.link).toContain(`<${CONTEXT_URL}>`);
    expect(res.headers.link).toContain(`rel="${JSONLD_CONTEXT_REL}"`);
  });

  it("advertises the canonical context on an opportunity detail", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/opportunities/ctest:1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.link).toBe(JSONLD_CONTEXT_LINK);
  });

  // A processor MUST follow an advertised context on any `+json` type that is not ld+json.
  // Advertising here would instruct it to read a JSON Schema document as an opportunity.
  it("never advertises a context on an application/schema+json response", async () => {
    for (const url of [
      "/v1/opportunities/schema",
      "/schemas/v1.0.0/opportunity.schema.json",
      "/meta/rfphub-schema.meta.json",
      "/registries/entry.schema.json",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-type"], url).toContain("application/schema+json");
      expect(res.headers.link, url).toBeUndefined();
    }
  });

  it("never advertises a context on the context document itself", async () => {
    const res = await app.inject({ method: "GET", url: "/schemas/v1.0.0/context.jsonld" });
    expect(res.headers["content-type"]).toContain("application/ld+json");
    expect(res.headers.link).toBeUndefined();
  });

  // The error body's keys are not terms in the context; interpreting one through it is noise.
  it("never advertises a context on a non-200 opportunity response", async () => {
    for (const url of ["/v1/opportunities/ctest:missing", "/v1/opportunities?sort=nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.headers.link, url).toBeUndefined();
    }
  });

  // Scoping is Fastify encapsulation, not a URL test: the hook is registered inside the
  // opportunities plugin, so no route outside it can inherit the header.
  it("does not leak the advertisement onto unrelated endpoints", async () => {
    for (const url of ["/v1/stats", "/v1/health", "/", "/schemas/index.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers.link, url).toBeUndefined();
    }
  });

  // ------------------------------------------------- the apex reservation, with real data ---
  //
  // The DB-backed half of test/integration/apex-host.test.ts: the endpoints that need a database
  // answer on the API host and are absent from the apex, which is what "the apex is reserved for
  // the spec" has to mean once one deployable answers on both names (adr/0007).

  it("answers the opportunity endpoints on the API host, with the context advertisement", async () => {
    for (const url of ["/v1/opportunities?ecosystem=CANONTEST", "/v1/opportunities/ctest:1"]) {
      const res = await app.inject({ method: "GET", url, headers: { host: `api.${APEX_HOST}` } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers.link, url).toBe(JSONLD_CONTEXT_LINK);
    }
  });

  it("does not answer them on the apex, and advertises nothing there", async () => {
    for (const url of ["/v1/opportunities?ecosystem=CANONTEST", "/v1/opportunities/ctest:1"]) {
      const res = await app.inject({ method: "GET", url, headers: { host: APEX_HOST } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().message, url).toContain("reserved");
      expect(res.headers.link, url).toBeUndefined();
    }
  });
});
