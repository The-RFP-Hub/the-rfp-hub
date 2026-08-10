import type { FastifyInstance } from "fastify";
import { advertiseJsonLdContext } from "../../shared/jsonld-link.js";
import { opportunityController } from "./opportunity.controller.js";
import { listQuerySchema } from "./types.js";

/** Registers the /v1/opportunities routes (mounted with that prefix by the aggregator). */
export const opportunities = async (router: FastifyInstance): Promise<void> => {
  // Every application/json opportunity response advertises the canonical JSON-LD context, so a
  // conformant processor reads it as linked data without an `@context` in the payload. Scoped
  // to this plugin: it must never land on the `application/schema+json` route below.
  advertiseJsonLdContext(router);

  router.get(
    "/",
    {
      // Serve (and document) the prefix itself — /v1/opportunities, no trailing slash.
      prefixTrailingSlash: "no-slash",
      schema: {
        operationId: "listOpportunities",
        tags: ["opportunities"],
        summary: "List opportunities (thin projection)",
        querystring: listQuerySchema,
        response: {
          200: { $ref: "PaginatedOpportunities#" },
          400: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityController.getAll,
  );

  // static `/schema` is matched ahead of the `/:id` param route by the router.
  // Served as `application/schema+json` (RFC 9485 / the JSON Schema media type) rather than
  // wrapped in an envelope, so a generic validator can consume the URL directly.
  router.get(
    "/schema",
    {
      schema: {
        operationId: "getOpportunitySchema",
        tags: ["opportunities"],
        summary: "The RFP Hub Standard JSON Schema (application/schema+json)",
        response: {
          200: {
            content: {
              "application/schema+json": { schema: { $ref: "SchemaResponse#" } },
            },
          },
          304: { description: "Not modified — the entity-tag you hold is current." },
        },
      },
    },
    opportunityController.schema,
  );

  router.get(
    "/:id",
    {
      schema: {
        operationId: "getOpportunity",
        tags: ["opportunities"],
        summary: "Get one opportunity (full Standard object)",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Public id, e.g. fundingmap:1459" } },
          required: ["id"],
        },
        response: {
          200: { $ref: "Opportunity#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityController.find,
  );
};
