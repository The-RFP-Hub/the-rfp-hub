import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type CanonicalDocument,
  type ServedSpecDocument,
  assertSelfIdentifies,
  canonicalDocuments,
  ifNoneMatchSatisfied,
} from "../../shared/canonical-documents.js";

/**
 * Send one of the Standard's files with its cache policy and validator.
 *
 * Shared with `/v1/opportunities/schema`, which serves the same bytes as the canonical schema URL —
 * two URLs for one document must not disagree about how long it may be cached or what its
 * entity-tag is — and with `routes/spec-artifacts`, the mirror of the rest of the published tree,
 * so a `FIELDS.md` out of the frozen directory gets exactly the semantics its neighbours get.
 */
export async function sendCanonical(
  doc: ServedSpecDocument,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> {
  res.header("Cache-Control", doc.cacheControl).header("ETag", doc.etag);
  if (ifNoneMatchSatisfied(req.headers["if-none-match"], doc.etag)) {
    return res.code(304).send();
  }
  // A Buffer payload bypasses Fastify's response serializer, so the bytes a consumer receives
  // are the bytes the package ships — same document, same digest.
  return res.type(doc.mediaType).send(doc.body);
}

/**
 * The spec's canonical documents, each served at the path its own identifier names.
 *
 * Registered at the ROOT — `/schemas/…`, `/meta/…`, `/registries/…` — because these are the
 * standard's identifiers, not API resources, and an identifier must not carry an API version.
 * `/v1/opportunities/schema` stays where it is: that one IS an API resource (a convenience for
 * a client already talking to `/v1/`), and it serves the same bytes through the same module.
 *
 * The apex is reserved for the spec (`adr/0007`), so these paths can never collide with a
 * future API route.
 */
export const canonical = async (router: FastifyInstance): Promise<void> => {
  assertSelfIdentifies();

  for (const doc of canonicalDocuments) {
    router.get(
      doc.path,
      {
        schema: {
          operationId: doc.operationId,
          tags: ["spec"],
          summary: `${doc.summary} (${doc.mediaType})`,
          description:
            `Served verbatim from \`@the-rfp-hub/standard\` at the document's canonical URL, \`${doc.url}\`. ` +
            `Cached as \`${doc.cacheControl}\`, with a strong \`ETag\`; send \`If-None-Match\` for a 304.`,
          response: {
            200: { content: { [doc.mediaType]: { schema: { $ref: `${doc.component}#` } } } },
            304: { description: "Not modified — the entity-tag you hold is current." },
          },
        },
      },
      async (req, res) => sendCanonical(doc as CanonicalDocument, req, res),
    );
  }
};
