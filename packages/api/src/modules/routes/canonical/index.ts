import type { FastifyInstance } from "fastify";
import {
  type CanonicalDocument,
  assertSelfIdentifies,
  canonicalDocuments,
} from "../../shared/canonical-documents.js";

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
          description: `Served verbatim from \`@the-rfp-hub/standard\` at the document's canonical URL, \`${doc.url}\`.`,
          response: {
            200: { content: { [doc.mediaType]: { schema: { $ref: `${doc.component}#` } } } },
          },
        },
      },
      // A Buffer payload bypasses Fastify's response serializer, so the bytes a consumer
      // receives are the bytes the package ships — same document, same digest.
      async (_req, res) => res.type(doc.mediaType).send((doc as CanonicalDocument).body),
    );
  }
};
