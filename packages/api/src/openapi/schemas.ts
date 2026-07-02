/**
 * Reusable response schemas, registered on the Fastify instance so both the OpenAPI 3.1 document
 * (served at /v1/docs/json) and the response serializer reference them by `$ref`.
 *
 * Standard objects use `additionalProperties: true` on purpose: the serializer must pass the full
 * Standard object through untouched (the `opportunity[type]` block, `extensions`, etc. are extra
 * properties) — a strict schema here would silently drop fields.
 */
export const responseSchemas = [
  {
    $id: "Opportunity",
    type: "object",
    additionalProperties: true,
    required: [
      "specVersion",
      "id",
      "type",
      "title",
      "description",
      "status",
      "organization",
      "source",
    ],
    properties: {
      specVersion: { type: "string" },
      id: { type: "string" },
      type: {
        type: "string",
        enum: ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"],
      },
      title: { type: "string" },
      description: { type: "string" },
      summary: { type: ["string", "null"] },
      status: { type: "string", enum: ["upcoming", "open", "closed", "archived"] },
      organization: { type: "object", additionalProperties: true },
      source: { type: "object", additionalProperties: true },
      ecosystems: { type: "array", items: { type: "string" } },
      networks: { type: "array", items: { type: "string" } },
      categories: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      funding: { type: "object", additionalProperties: true },
    },
  },
  {
    $id: "PaginatedOpportunities",
    type: "object",
    additionalProperties: false,
    required: ["items", "page", "limit", "total", "totalPages"],
    properties: {
      items: { type: "array", items: { $ref: "Opportunity" } },
      page: { type: "integer" },
      limit: { type: "integer" },
      total: { type: "integer" },
      totalPages: { type: "integer" },
    },
  },
  {
    $id: "Stats",
    type: "object",
    additionalProperties: false,
    required: ["total", "byType", "byStatus", "topEcosystems", "lastUpdatedAt"],
    properties: {
      total: { type: "integer" },
      byType: { type: "object", additionalProperties: { type: "integer" } },
      byStatus: { type: "object", additionalProperties: { type: "integer" } },
      topEcosystems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ecosystem", "count"],
          properties: { ecosystem: { type: "string" }, count: { type: "integer" } },
        },
      },
      lastUpdatedAt: { type: ["string", "null"] },
    },
  },
  {
    $id: "SchemaResponse",
    type: "object",
    additionalProperties: false,
    required: ["specVersion", "schema"],
    properties: {
      specVersion: { type: "string" },
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    $id: "Health",
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string" }, db: { type: "string" } },
  },
  {
    $id: "ErrorResponse",
    type: "object",
    additionalProperties: true,
    required: ["error"],
    properties: {
      error: { type: "string" },
      message: { type: "string" },
      statusCode: { type: "integer" },
    },
  },
] as const;
