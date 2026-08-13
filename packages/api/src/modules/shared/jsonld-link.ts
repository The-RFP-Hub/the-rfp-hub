/**
 * HTTP `Link` advertisement of the JSON-LD context.
 *
 * A plain `application/json` body carries no linked-data meaning. JSON-LD 1.1 §"Interpreting
 * JSON as JSON-LD" fixes that from the HTTP layer instead of the payload: when a response is
 * `application/json` (or any `+json` type that is NOT `application/ld+json`) and carries a
 * `Link` header with `rel="http://www.w3.org/ns/json-ld#context"`, a conformant processor MUST
 * fetch that context and interpret the body through it. Every opportunity response becomes
 * linked data for zero payload bytes and no `@context` pollution.
 *
 * `ARTIFACTS.md` gated this on the canonical domain decision, and correctly: a processor MUST
 * follow the advertised URL, so advertising one before it is stable pins every consumer to
 * whatever the URL happened to be. It is stable now (`adr/0007`), and frozen.
 *
 * WHERE IT MUST NOT GO. The same rule that makes this work makes it dangerous on the wrong
 * response. `application/schema+json` carries the `+json` suffix, so a `Link` header on the
 * canonical schema route would instruct processors to read a JSON Schema document as an RFP Hub
 * opportunity. The header therefore goes on `application/json` 200 responses only — never on
 * the canonical-document routes, and never on an error body, whose `{error, message}` keys are
 * not terms in the context.
 */
import type { FastifyInstance } from "fastify";
import { CONTEXT_URL } from "./canonical-documents.js";

/** The IANA-registered JSON-LD context link relation. */
export const JSONLD_CONTEXT_REL = "http://www.w3.org/ns/json-ld#context";

/** The exact header value advertised, per RFC 8288 field syntax. */
export const JSONLD_CONTEXT_LINK = `<${CONTEXT_URL}>; rel="${JSONLD_CONTEXT_REL}"; type="application/ld+json"`;

/**
 * Advertise the context on this plugin's `application/json` 200 responses.
 *
 * Fastify encapsulation is what scopes it: registering the hook inside a route plugin applies
 * it to that plugin's routes and nothing else, so the canonical-document routes registered
 * elsewhere cannot pick it up by accident.
 */
export function advertiseJsonLdContext(router: FastifyInstance): void {
  router.addHook("onSend", async (_req, reply, payload) => {
    const contentType = reply.getHeader("content-type");
    if (reply.statusCode === 200 && String(contentType ?? "").startsWith("application/json")) {
      reply.header("link", JSONLD_CONTEXT_LINK);
    }
    return payload;
  });
}
