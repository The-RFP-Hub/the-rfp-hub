import type { FastifyInstance } from "fastify";
import { opportunityController } from "./opportunity.controller.js";
import { listQuerySchema } from "./types.js";

/** Registers the /v1/opportunities routes (mounted with that prefix by the aggregator). */
export const opportunities = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      schema: {
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
        tags: ["opportunities"],
        summary: "The RFP Hub Standard JSON Schema (application/schema+json)",
        response: {
          200: {
            content: {
              "application/schema+json": { schema: { $ref: "SchemaResponse#" } },
            },
          },
        },
      },
    },
    opportunityController.schema,
  );

  router.get(
    "/:id",
    {
      schema: {
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
