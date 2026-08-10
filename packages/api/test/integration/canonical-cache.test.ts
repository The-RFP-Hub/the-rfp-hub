/**
 * CACHING THE SPEC'S DOCUMENTS.
 *
 * These are fetched by validators and JSON-LD processors on a machine's schedule, and every
 * uncached fetch reached a database-backed API service for bytes that came off disk. Worse, with
 * no policy at all an API outage made a permanent, widely-cacheable context unavailable even to
 * clients that had already fetched it — which is the exact availability risk `adr/0007` says the
 * freeze mitigates. The mitigation only exists if the responses say so.
 *
 * No database: none of these routes touches one.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  canonicalDocuments,
  entityTag,
  ifNoneMatchSatisfied,
  specConfig,
} from "../../src/modules/shared/canonical-documents.js";

describe("cache policy and validators on the canonical documents", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers });

  it("promises an unbounded lifetime only where the URL carries the spec version", () => {
    for (const doc of canonicalDocuments) {
      const versioned = doc.path.startsWith(`/${specConfig.schemaDir}/`);
      expect(doc.cacheControl, doc.path).toBe(versioned ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    }
    // The frozen version directory is the only thing that licenses `immutable`.
    expect(IMMUTABLE_CACHE).toContain("immutable");
    expect(REVALIDATE_CACHE).not.toContain("immutable");
  });

  it("sends Cache-Control and a strong ETag on every canonical document", async () => {
    for (const doc of canonicalDocuments) {
      const res = await get(doc.path);
      expect(res.statusCode, doc.path).toBe(200);
      expect(res.headers["cache-control"], doc.path).toBe(doc.cacheControl);
      expect(res.headers.etag, doc.path).toBe(doc.etag);
      // Strong: no `W/` prefix, and derived from the bytes actually sent.
      expect(String(res.headers.etag), doc.path).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(res.headers.etag, doc.path).toBe(entityTag(res.rawPayload));
    }
  });

  it("answers 304 to a conditional request, with no body and the headers still set", async () => {
    for (const doc of canonicalDocuments) {
      const res = await get(doc.path, { "if-none-match": doc.etag });
      expect(res.statusCode, doc.path).toBe(304);
      expect(res.rawPayload.length, doc.path).toBe(0);
      expect(res.headers.etag, doc.path).toBe(doc.etag);
      expect(res.headers["cache-control"], doc.path).toBe(doc.cacheControl);
    }
  });

  it("still sends the document when the entity-tag does not match", async () => {
    const doc = canonicalDocuments[0];
    if (!doc) throw new Error("no canonical documents");
    const res = await get(doc.path, { "if-none-match": '"not-the-tag"' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(doc.body)).toBe(true);
  });

  // RFC 9110 § 13.1.2: a list, `*`, and the weak comparison function.
  it("matches If-None-Match the way the RFC says", () => {
    const tag = '"abc"';
    expect(ifNoneMatchSatisfied(tag, tag)).toBe(true);
    expect(ifNoneMatchSatisfied("*", tag)).toBe(true);
    expect(ifNoneMatchSatisfied(`"other", ${tag}`, tag)).toBe(true);
    expect(ifNoneMatchSatisfied(`W/${tag}`, tag)).toBe(true);
    expect(ifNoneMatchSatisfied('"other"', tag)).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, tag)).toBe(false);
  });

  // Two URLs, one document: the bytes and the validator must agree, and only the promise about
  // the URL may differ — `/v1/opportunities/schema` names no spec version, so it revalidates.
  it("gives the /v1 alias the same ETag but the revalidating policy", async () => {
    const canonical = await get(`/${specConfig.schemaDir}/opportunity.schema.json`);
    const alias = await get("/v1/opportunities/schema");
    expect(alias.rawPayload.equals(canonical.rawPayload)).toBe(true);
    expect(alias.headers.etag).toBe(canonical.headers.etag);
    expect(canonical.headers["cache-control"]).toBe(IMMUTABLE_CACHE);
    expect(alias.headers["cache-control"]).toBe(REVALIDATE_CACHE);

    const conditional = await get("/v1/opportunities/schema", {
      "if-none-match": String(alias.headers.etag),
    });
    expect(conditional.statusCode).toBe(304);
  });

  // The one header deliberately absent, so its absence is a decision rather than an oversight.
  it("sends no Last-Modified — the only timestamp available is the build's", async () => {
    for (const doc of canonicalDocuments) {
      const res = await get(doc.path);
      expect(res.headers["last-modified"], doc.path).toBeUndefined();
    }
  });
});
