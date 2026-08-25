/**
 * THE PUBLICATION TREE, SERVED.
 *
 * `canonical.test.ts` covers the five documents an identifier names. This file covers the claim
 * around them: that `/schemas/v1.0.0/…`, `/meta/…` and `/registries/…` are the Standard's own
 * directories mirrored read-only — every file in them, at its own path, as the bytes the package
 * ships, under a media type a machine can act on, with the cache semantics the freeze licenses.
 *
 * The assertions that matter most are the ones about what is NOT served. A read-only mirror of a
 * directory is one traversal bug away from being a filesystem browser, so the tree is compared
 * against the repository's own files (nothing extra is published, nothing is missing), and `..` is
 * attacked plain, encoded and double-encoded. It cannot succeed by construction — the allowlist is
 * the Fastify route table, built by walking the directory before the server listens, and no request
 * path is ever joined onto a filesystem path — but "cannot by construction" is exactly the kind of
 * claim that stops being true during a refactor.
 *
 * No database: none of these routes touches one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  canonicalDocuments,
  entityTag,
  specConfig,
} from "../../src/modules/shared/canonical-documents.js";
import {
  PUBLISHED_TREES,
  mediaTypeFor,
  specArtifacts,
} from "../../src/modules/shared/spec-artifacts.js";
import { APEX_HOST } from "../../src/plugins/apex-host.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The repository's own copy — deliberately NOT the one the server resolved through node_modules. */
const standardRoot = join(here, "..", "..", "..", "standard");

/** Every file under `relative` in the REPOSITORY, as package subpaths. */
function walkRepo(relative: string): string[] {
  return readdirSync(join(standardRoot, relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walkRepo(posix.join(relative, entry.name))
      : [posix.join(relative, entry.name)],
  );
}

const repoSources = PUBLISHED_TREES.flatMap((tree) => walkRepo(tree)).sort();
const versionDir = `/${specConfig.schemaDir}/`;

describe("the Standard's published directories, mirrored at the host root", () => {
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

  // ------------------------------------------------------------------ the tree ---

  it("mirrors exactly the files the package publishes — no more, no fewer", () => {
    // Plus exactly ONE deliberate non-file route: the extensionless vocabulary identifier. The
    // vocab IRI is `…/ns/rfp#term`, and a fragment IRI dereferences at the IRI minus its
    // fragment — so `/ns/rfp` must answer even though the bytes live in `ns/rfp.jsonld`. Every
    // OTHER artifact still maps one file to one path; the dedup below is what proves the alias
    // is the only exception rather than a leak in the mirror.
    const sources = [...new Set(specArtifacts.map((a) => a.source))].sort();
    expect(sources).toEqual(repoSources);
    // The mirror is a superset of the identifiers, which is what makes the directory a directory
    // rather than a shortlist of five documents with holes between them.
    for (const doc of canonicalDocuments) {
      expect(
        specArtifacts.map((a) => a.path),
        doc.path,
      ).toContain(doc.path);
    }
    // And it is a real directory: the frozen version directory's informative documents, its
    // marker, and its examples are all in it.
    for (const source of [
      "schemas/v1.0.0/FIELDS.md",
      "schemas/v1.0.0/CROSSWALK.md",
      "schemas/v1.0.0/BENCHMARK.md",
      "schemas/v1.0.0/STATUS.md",
      "schemas/v1.0.0/FROZEN",
      "registries/deadline-labels.json",
      "registries/index.json",
    ]) {
      expect(repoSources, source).toContain(source);
    }
    expect(
      specArtifacts.filter((a) => a.source.startsWith("schemas/v1.0.0/examples/")),
    ).toHaveLength(30);
  });

  it("gives every file the path and URL its own place in the package implies", () => {
    const aliases: string[] = [];
    for (const artifact of specArtifacts) {
      if (artifact.path !== `/${artifact.source}`) {
        aliases.push(artifact.path);
        continue;
      }
      expect(artifact.url, artifact.source).toBe(`${specConfig.baseUrl}${artifact.path}`);
    }
    // The one path that is not its source's own name is the vocabulary identifier, and only it.
    expect(aliases).toEqual(["/ns/rfp"]);
  });

  it("dereferences the vocabulary IRI at the identifier itself, as JSON-LD", async () => {
    // The IRI in spec.config.json is the contract; the route is derived, so derive the
    // expectation the same way rather than typing /ns/rfp twice.
    const vocabPath = new URL(specConfig.vocabIri).pathname;
    const res = await get(vocabPath);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/ld+json");
    const doc = res.json();
    const namespace = (doc["@graph"] ?? []).find(
      (node: { "@id"?: string }) => node["@id"] === specConfig.vocabIri,
    );
    expect(namespace, "the namespace node must carry the vocab IRI itself").toBeTruthy();
    // Same bytes at the file's own path — the alias is an address, not a second document.
    const file = await get(`${vocabPath}.jsonld`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe(res.body);
  });

  // The two modules read one package by two different routes — the `exports` map a subpath at a
  // time, and a directory walk. Where they overlap they must not have decided different things.
  it("agrees with the canonical documents about the files they both describe", () => {
    const mirrored = new Map(specArtifacts.map((a) => [a.path, a]));
    for (const doc of canonicalDocuments) {
      const artifact = mirrored.get(doc.path);
      expect(artifact, doc.path).toBeDefined();
      expect(artifact?.mediaType, doc.path).toBe(doc.mediaType);
      expect(artifact?.cacheControl, doc.path).toBe(doc.cacheControl);
      expect(artifact?.etag, doc.path).toBe(doc.etag);
      expect(artifact?.body.equals(doc.body), doc.path).toBe(true);
    }
  });

  // ------------------------------------------------------------- what is served ---

  it("serves every file, byte for byte, with a 200 and never a redirect", async () => {
    for (const artifact of specArtifacts) {
      const res = await get(artifact.path);
      expect(res.statusCode, artifact.path).toBe(200);
      expect(res.headers.location, artifact.path).toBeUndefined();
      // The bytes the repository holds, not a re-serialization of them: a consumer that hashes
      // the served file gets the same digest as one that hashes the file in the package.
      const onDisk = readFileSync(join(standardRoot, artifact.source));
      expect(res.rawPayload.equals(onDisk), artifact.path).toBe(true);
    }
  });

  /**
   * The media type IS the interoperability contract: a JSON Schema served as `application/json` is
   * not `$ref`-able by a generic validator, a context served as anything but `ld+json` is not a
   * context, and Markdown served without a charset is Markdown a reader is free to mis-decode.
   */
  it("labels each kind of file as what it is", async () => {
    const expected: Record<string, string> = {
      "/schemas/v1.0.0/context.jsonld": "application/ld+json",
      "/schemas/v1.0.0/opportunity.schema.json": "application/schema+json",
      "/meta/rfphub-schema.meta.json": "application/schema+json",
      "/registries/entry.schema.json": "application/schema+json",
      "/registries/deadline-labels.json": "application/json",
      "/schemas/index.json": "application/json",
      "/schemas/v1.0.0/examples/29-bounty-security-ethereum-foundation.json": "application/json",
      "/schemas/v1.0.0/FIELDS.md": "text/markdown; charset=utf-8",
      "/schemas/v1.0.0/STATUS.md": "text/markdown; charset=utf-8",
      "/schemas/v1.0.0/FROZEN": "text/plain; charset=utf-8",
    };
    for (const [path, mediaType] of Object.entries(expected)) {
      expect(mediaTypeFor(path.slice(1)), path).toBe(mediaType);
      const res = await get(path);
      expect(res.headers["content-type"], path).toBe(mediaType);
    }
    // Every text response says its charset; the `+json` types need none (JSON is UTF-8 by
    // definition, RFC 8259 § 8.1) and must not invent one.
    for (const artifact of specArtifacts) {
      const declaresCharset = artifact.mediaType.includes("charset=utf-8");
      expect(artifact.mediaType.startsWith("text/"), artifact.path).toBe(declaresCharset);
    }
  });

  // ------------------------------------------------------------ cache + validators ---

  it("promises an unbounded lifetime exactly where the URL carries the spec version", async () => {
    for (const artifact of specArtifacts) {
      const versioned = artifact.path.startsWith(versionDir);
      expect(artifact.cacheControl, artifact.path).toBe(
        versioned ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
      );
      const res = await get(artifact.path);
      expect(res.headers["cache-control"], artifact.path).toBe(artifact.cacheControl);
    }
    // The frozen version directory is what licenses `immutable`, and it is where the bulk lives.
    expect(specArtifacts.filter((a) => a.path.startsWith(versionDir)).length).toBeGreaterThan(30);
  });

  it("sends a strong, content-derived ETag on every file and honours If-None-Match", async () => {
    for (const artifact of specArtifacts) {
      const res = await get(artifact.path);
      expect(res.headers.etag, artifact.path).toBe(artifact.etag);
      expect(String(res.headers.etag), artifact.path).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(res.headers.etag, artifact.path).toBe(entityTag(res.rawPayload));
      // No Last-Modified: the only timestamp available is the build's, and it changes for bytes
      // that did not (adr/0007).
      expect(res.headers["last-modified"], artifact.path).toBeUndefined();

      const conditional = await get(artifact.path, { "if-none-match": artifact.etag });
      expect(conditional.statusCode, artifact.path).toBe(304);
      expect(conditional.rawPayload.length, artifact.path).toBe(0);
      expect(conditional.headers.etag, artifact.path).toBe(artifact.etag);
      expect(conditional.headers["cache-control"], artifact.path).toBe(artifact.cacheControl);
    }
  });

  it("still sends the file when the entity-tag does not match", async () => {
    const res = await get("/schemas/v1.0.0/FIELDS.md", { "if-none-match": '"not-the-tag"' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ HEAD + CORS ---

  it("answers HEAD with the same headers and no body", async () => {
    for (const path of [
      "/schemas/v1.0.0/FIELDS.md",
      "/schemas/v1.0.0/examples/01-hackathon-fundingmap_1200.json",
      "/registries/program-models.json",
    ]) {
      const head = await app.inject({ method: "HEAD", url: path });
      const body = await get(path);
      expect(head.statusCode, path).toBe(200);
      expect(head.rawPayload.length, path).toBe(0);
      expect(head.headers["content-type"], path).toBe(body.headers["content-type"]);
      expect(head.headers.etag, path).toBe(body.headers.etag);
      expect(head.headers["cache-control"], path).toBe(body.headers["cache-control"]);
      expect(Number(head.headers["content-length"]), path).toBe(body.rawPayload.length);
    }
  });

  /**
   * A JSON-LD processor running in a browser fetches an advertised `@context` cross-origin, and a
   * schema validator follows `$ref`s the same way. Without this header both fail in a way that
   * looks like the document is missing.
   */
  it("allows any origin, with and without an Origin header", async () => {
    for (const path of ["/schemas/v1.0.0/context.jsonld", "/schemas/v1.0.0/CROSSWALK.md"]) {
      const plain = await get(path);
      expect(plain.headers["access-control-allow-origin"], path).toBe("*");
      const cross = await get(path, { origin: "https://example.org" });
      expect(cross.headers["access-control-allow-origin"], path).toBe("*");
    }
  });

  // ---------------------------------------------------------------- what 404s ---

  /**
   * The allowlist is the route table, so an escape attempt is a path that matches no route. These
   * assert the outcome anyway, because the property is worth a test that survives a refactor of
   * how the tree is built.
   */
  it("serves nothing outside the published directories", async () => {
    for (const url of [
      "/schemas/v1.0.0/../../package.json",
      "/schemas/v1.0.0/%2e%2e/%2e%2e/package.json",
      "/schemas/v1.0.0/..%2f..%2fpackage.json",
      "/schemas/v1.0.0/%252e%252e/package.json",
      "/schemas/v1.0.0/examples/../../../../package.json",
      "/schemas/v1.0.0/./../../LICENSE",
      "/package.json",
      "/spec.config.json",
      "/dist/index.js",
      "/conformance/v1.0.0/pass/grant.json",
      "/schemas/v1.0.0/opportunity.schema.json.map",
      "/../packages/api/package.json",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      // The API's standard error shape, not a filesystem error and not HTML.
      expect(res.json(), url).toMatchObject({ error: "not_found" });
    }
  });

  // Directory listings are not a thing this serves: the package ships no index for the version
  // directory, and synthesising one would put an API-shaped document — whose format can change —
  // inside a directory whose whole promise is that its bytes cannot.
  it("does not list directories", async () => {
    for (const url of [
      "/schemas/",
      "/schemas/v1.0.0/",
      "/schemas/v1.0.0/examples/",
      "/registries/",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error, url).toBe("not_found");
    }
    // The shipped, machine-readable entry point is the one that answers instead.
    expect((await get("/schemas/index.json")).statusCode).toBe(200);
    // A trailing slash on a FILE still resolves to that file — the app-wide
    // `routerOptions.ignoreTrailingSlash` behaviour every other route here has, not a special case.
    const strayFile = await get("/schemas/v1.0.0/FIELDS.md/");
    expect(strayFile.statusCode).toBe(200);
    expect(strayFile.headers["content-type"]).toBe("text/markdown; charset=utf-8");
  });

  // -------------------------------------------------------- apex + OpenAPI surface ---

  // The apex is the identifier authority (adr/0007). A file that answers on the API host and 404s
  // on the apex would make the mirror true only where it is least needed.
  it("answers on the apex host, identically", async () => {
    for (const path of [
      "/schemas/v1.0.0/FIELDS.md",
      "/schemas/v1.0.0/examples/10-grant-fundingmap_600.json",
      "/registries/bounty-severities.json",
    ]) {
      const apex = await get(path, { host: APEX_HOST });
      const api = await get(path, { host: `api.${APEX_HOST}` });
      expect(apex.statusCode, path).toBe(200);
      expect(apex.rawPayload.equals(api.rawPayload), path).toBe(true);
    }
    // …and the apex reservation is not widened by any of this.
    const denied = await get("/v1/stats", { host: APEX_HOST });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().message).toContain("reserved");
  });

  /**
   * The mirror is deliberately absent from the OpenAPI document: forty-odd operations that differ
   * only in path would outnumber the API's real ones and describe files that belong to the
   * identifier authority rather than to `servers[0]`. The five identifiers stay in it, and
   * `openapi.test.ts` asserts that they do.
   */
  it("stays out of the OpenAPI document", async () => {
    const doc = (await get("/v1/docs/json")).json();
    const documented = Object.keys(doc.paths);
    const identifiers = new Set(canonicalDocuments.map((d) => d.path));
    for (const artifact of specArtifacts) {
      if (identifiers.has(artifact.path)) {
        expect(documented, artifact.path).toContain(artifact.path);
        continue;
      }
      expect(documented, artifact.path).not.toContain(artifact.path);
    }
  });
});
