import type { FastifyInstance } from "fastify";
import { feedController } from "./feed.controller.js";
import { feedQuerySchema } from "./types.js";

/**
 * The two feed operations, documented the way every non-JSON route in this API is: through
 * `response.content`, keyed by the media type actually served (the same shape
 * `/v1/opportunities/schema` uses for `application/schema+json`).
 *
 * The schema for that media type is `type: "string"` — an XML document has no JSON Schema, and
 * OpenAPI's own XML support describes how a JSON object is projected INTO XML, which is not what
 * these are: they are Atom and RSS, whose shapes are defined by RFC 4287 and the RSS 2.0
 * specification, not by this API. So the description names the governing specification and the
 * elements a consumer can rely on, and the media type carries the rest. Nothing is serialized
 * through that schema — the handler sends a `Buffer`, which bypasses the serializer.
 */
const SHARED_DESCRIPTION = [
  "The most recently published opportunities, newest first — the same public slice as GET /v1/opportunities",
  "(approved and listed records only), ordered by when the Hub first published each record",
  "(`createdAt` descending — not the funder's own announcement date, `postedAt`), capped at `limit` entries.",
  "Sent with a strong `ETag`: send `If-None-Match` when polling and get a 304 instead of the document.",
].join(" ");

const xmlResponse = (mediaType: string, description: string) => ({
  content: { [mediaType]: { schema: { type: "string", description } } },
});

export const feeds = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/opportunities.atom",
    {
      schema: {
        operationId: "getOpportunitiesAtomFeed",
        tags: ["feeds"],
        summary: "Atom 1.0 feed of the most recent opportunities",
        description: `${SHARED_DESCRIPTION} Entry ids are the records' own /v1/opportunities/{id} URLs under PUBLIC_BASE_URL.`,
        querystring: feedQuerySchema,
        response: {
          200: xmlResponse(
            "application/atom+xml",
            "An Atom 1.0 document (RFC 4287): a `feed` carrying `id`, `title` and `updated`, a `link rel=self`, and one `entry` per opportunity with `id`, `title`, `updated`, `link`, a plain-text `summary`, `category` terms (funding type, then ecosystems) and the operating organization as `author`.",
          ),
          400: { $ref: "ErrorResponse#" },
        },
      },
    },
    feedController.atom,
  );

  router.get(
    "/opportunities.rss",
    {
      schema: {
        operationId: "getOpportunitiesRssFeed",
        tags: ["feeds"],
        summary: "RSS 2.0 feed of the most recent opportunities",
        description: `${SHARED_DESCRIPTION} Item guids are non-permalink identifiers, equal to the Atom feed's entry ids.`,
        querystring: feedQuerySchema,
        response: {
          200: xmlResponse(
            "application/rss+xml",
            "An RSS 2.0 document: a `channel` carrying `title`, `link` and `description`, an `atom:link rel=self`, and one `item` per opportunity with `title`, `link`, a non-permalink `guid`, `description`, `pubDate`, `category` terms and the operating organization as `dc:creator`.",
          ),
          400: { $ref: "ErrorResponse#" },
        },
      },
    },
    feedController.rss,
  );
};
