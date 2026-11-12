import type { FastifyInstance } from "fastify";
import { advertiseJsonLdContext } from "../../shared/jsonld-link.js";
import { opportunityController } from "./opportunity.controller.js";
import { listQuerySchema } from "./types.js";

/** Registers the /v1/opportunities routes (mounted with that prefix by the aggregator). */
export const opportunities = async (router: FastifyInstance): Promise<void> => {
  // Every application/json opportunity response advertises the canonical JSON-LD context, so a
  // conformant processor reads it as linked data without an `@context` in the payload. Scoped
  // to this plugin AND narrowed to the two operations that actually serve Standard objects: the
  // `application/schema+json` route below must never carry it, and neither must anything added
  // here later. The writes, the claim and the audit/duplicate/verification sub-resources live in
  // their own plugins (routes/submissions, routes/opportunity-meta) for the same reason.
  advertiseJsonLdContext(router, { only: ["/v1/opportunities", "/v1/opportunities/:id"] });

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
    "/:id/claim-status",
    {
      schema: {
        operationId: "getOpportunityClaimStatus",
        tags: ["opportunities"],
        summary: "Whether this public listing still accepts ownership claims",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["canClaim"],
            properties: { canClaim: { type: "boolean" } },
          },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityController.claimStatus,
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
        // STRICT, like every other public read that declares a querystring (docs/api-integration.md
        // §4.1). Declaring `count` put a query parameter in the published document, and from then on
        // the compliance contract (M2-2, scripts/compliance/checks/openapi.mjs) holds this route to
        // "an undocumented parameter is a 400, never a silently ignored 200". A misspelled
        // `?cuont=false` quietly counting the read is exactly the failure that contract exists for.
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: {
              type: "boolean",
              default: true,
              description:
                "`false` serves the same record without recording a detail view. For a read that is not somebody reading the listing — the frontend's leaving page, which already counted the click that sent the reader there. It can only lower a count, like `DNT: 1`.",
            },
          },
        },
        response: {
          200: { $ref: "Opportunity#" },
          400: { $ref: "ErrorResponse#" },
          404: {
            oneOf: [{ $ref: "ErrorResponse#" }, { $ref: "MergedOpportunityErrorResponse#" }],
          },
        },
      },
    },
    opportunityController.find,
  );
};
