/**
 * THE SPEC'S CANONICAL DOCUMENTS, and the URLs that identify them.
 *
 * Every identifier the RFP Hub Standard publishes is an absolute URL on the canonical domain
 * (`adr/0007`). An identifier that does not dereference is a promise nobody can check, so the
 * API serves each document at exactly the path its own `$id` names — `/schemas/v1.0.0/…`,
 * `/meta/…`, `/registries/…` — at the ROOT, not under `/v1/`. These are not API resources and
 * must not carry an API version: `$id` is forever, `/v1/` is not.
 *
 * Nothing here is hand-written. The paths are computed from the identifiers, the identifiers
 * come from the Standard's own `spec.config.json`, and the bytes are the Standard's shipped
 * files read verbatim — so this file cannot drift from the package it serves, and a future
 * spec version needs no edit here. Three JSON Schema documents additionally SELF-identify, and
 * `assertSelfIdentifies` fails at boot if a document's `$id` disagrees with the URL it is being
 * served at. That is the one way this could silently lie, so it is checked rather than trusted.
 *
 * The bytes are served as read: a `Buffer` payload bypasses Fastify's response serializer, so a
 * consumer that hashes the document gets the same digest as one that hashes the file in the
 * package. Re-serializing would reorder keys for no gain.
 *
 * This is a transitional home. `ARTIFACTS.md` and `adr/0007` both record the end state — the
 * package directory published to object storage behind a CDN, with the apex pointed at it —
 * which retires this module entirely without any identifier changing. Until then spec
 * resolution rides the API's uptime, which is a compromise and is written down as one.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Read a file the `@the-rfp-hub/standard` package ships, through its own `exports` map. */
function readStandardFile(subpath: string): Buffer {
  return readFileSync(require.resolve(`@the-rfp-hub/standard/${subpath}`));
}

interface SpecConfig {
  specVersion: string;
  schemaDir: string;
  baseUrl: string;
  vocabIri: string;
}

/** The Standard's single hand-written source of identity. Every URL below derives from it. */
export const specConfig: SpecConfig = JSON.parse(
  readStandardFile("spec.config.json").toString("utf8"),
);

/** `https://…/schemas/v1.0.0/opportunity.schema.json` → `/schemas/v1.0.0/opportunity.schema.json`. */
function canonicalPath(identifier: string): string {
  const url = new URL(identifier);
  if (`${url.origin}${url.pathname}` !== identifier) {
    throw new Error(`canonical identifier '${identifier}' carries a query or fragment`);
  }
  if (!identifier.startsWith(`${specConfig.baseUrl}/`)) {
    throw new Error(`'${identifier}' is not under the Standard's baseUrl '${specConfig.baseUrl}'`);
  }
  return url.pathname;
}

export interface CanonicalDocument {
  /** The identifier this document is published under. */
  url: string;
  /** The route path — the identifier's own path component, by construction. */
  path: string;
  /** The package subpath the bytes come from; equal to `path` minus its leading slash. */
  source: string;
  mediaType: string;
  operationId: string;
  summary: string;
  /** The OpenAPI response component describing it. */
  component: string;
  /** True when the document carries an `$id` that must equal `url`. */
  selfIdentifying: boolean;
  body: Buffer;
}

function document(
  identifier: string,
  init: Omit<CanonicalDocument, "url" | "path" | "source" | "body">,
): CanonicalDocument {
  const path = canonicalPath(identifier);
  const source = path.slice(1);
  return { ...init, url: identifier, path, source, body: readStandardFile(source) };
}

const schemaBase = `${specConfig.baseUrl}/${specConfig.schemaDir}`;

/** The canonical URL of the schema — also what `$schema` in a self-identifying document names. */
export const SCHEMA_URL = `${schemaBase}/opportunity.schema.json`;
/** The canonical URL of the JSON-LD context, as advertised by the `Link` header. */
export const CONTEXT_URL = `${schemaBase}/context.jsonld`;

/**
 * `application/schema+json` for JSON Schema documents (RFC 9485), `application/ld+json` for the
 * context (JSON-LD 1.1). The versions index is neither — it is an ordinary JSON index.
 */
export const canonicalDocuments: readonly CanonicalDocument[] = Object.freeze([
  document(SCHEMA_URL, {
    mediaType: "application/schema+json",
    operationId: "getCanonicalSchema",
    summary: "The RFP Hub Standard JSON Schema, at its canonical $id",
    component: "SchemaResponse",
    selfIdentifying: true,
  }),
  document(CONTEXT_URL, {
    mediaType: "application/ld+json",
    operationId: "getCanonicalContext",
    summary: "The RFP Hub Standard JSON-LD context, at its canonical URL",
    component: "JsonLdContext",
    selfIdentifying: false,
  }),
  document(`${specConfig.baseUrl}/schemas/index.json`, {
    mediaType: "application/json",
    operationId: "getSpecVersionIndex",
    summary: "Machine-readable index of published spec versions",
    component: "SpecVersionIndex",
    selfIdentifying: false,
  }),
  document(`${specConfig.baseUrl}/meta/rfphub-schema.meta.json`, {
    mediaType: "application/schema+json",
    operationId: "getCanonicalMetaSchema",
    summary: "The metaschema the Standard's own schema validates against",
    component: "SchemaResponse",
    selfIdentifying: true,
  }),
  document(`${specConfig.baseUrl}/registries/entry.schema.json`, {
    mediaType: "application/schema+json",
    operationId: "getCanonicalRegistryEntrySchema",
    summary: "The schema every registry file conforms to",
    component: "SchemaResponse",
    selfIdentifying: true,
  }),
]);

/**
 * Fail at BOOT if a self-identifying document's `$id` disagrees with the URL it is served at.
 * Serving a schema whose `$id` points somewhere else is worse than not serving it: a validator
 * that follows the `$id` silently ends up somewhere the operator did not intend.
 */
export function assertSelfIdentifies(): void {
  for (const doc of canonicalDocuments) {
    if (!doc.selfIdentifying) continue;
    const { $id } = JSON.parse(doc.body.toString("utf8")) as { $id?: string };
    if ($id !== doc.url) {
      throw new Error(
        `canonical document ${doc.source} declares $id '${$id}' but is served at '${doc.url}'`,
      );
    }
  }
}

/** The Standard's schema as an object — the payload `/v1/opportunities/schema` has always served. */
export const opportunitySchemaDocument = canonicalDocuments[0] as CanonicalDocument;
