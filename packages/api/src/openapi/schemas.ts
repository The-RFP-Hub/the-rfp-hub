/**
 * Reusable response schemas, registered on the Fastify instance so both the OpenAPI 3.1 document
 * (served at /v1/docs/json) and the response serializer reference them by `$ref`.
 *
 * Standard objects use `additionalProperties: true` on purpose: the serializer must pass the full
 * Standard object through untouched (the `opportunity[fundingType]` block, `extensions`, etc. are
 * extra properties) — a strict schema here would silently drop fields.
 */
export const responseSchemas = [
  {
    $id: "Opportunity",
    type: "object",
    additionalProperties: true,
    required: [
      "specVersion",
      "id",
      "fundingType",
      "title",
      "description",
      "status",
      "sponsoringOrganizations",
      "source",
    ],
    properties: {
      specVersion: { type: "string" },
      id: { type: "string" },
      fundingType: {
        type: "string",
        enum: ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"],
        description:
          "Structural discriminator: the entry always carries a block under a key equal to this value, and never a block for any other type.",
      },
      title: { type: "string" },
      description: { type: "string" },
      summary: { type: ["string", "null"] },
      status: { type: "string", enum: ["upcoming", "open", "closed", "archived"] },
      sponsoringOrganizations: {
        type: "array",
        minItems: 1,
        items: { type: "object", additionalProperties: true },
        description: "Issuing/backing organizations. ARRAY ORDER IS SEMANTIC: [0] is primary.",
      },
      operatingOrganizations: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description: "Organizations that run intake/process, when distinct from the sponsor.",
      },
      source: { type: "object", additionalProperties: true },
      ecosystems: { type: "array", items: { type: "string" } },
      networks: { type: "array", items: { type: "string" } },
      categories: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      eligibility: { type: "object", additionalProperties: { type: "string" } },
      prerequisites: { type: ["string", "null"] },
      resourceLinks: { type: ["string", "null"] },
      serviceAgreement: { type: ["string", "null"] },
      applicationUrl: { type: ["string", "null"] },
      funding: { type: "object", additionalProperties: true },
      milestones: { type: "array", items: { type: "object", additionalProperties: true } },
      opensAt: { type: ["string", "null"] },
      deadlines: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description:
          "Every deadline and event boundary, each {type: fixed|rolling, date?, label?}. SELECT BY LABEL, never by array position.",
      },
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
    required: ["total", "byFundingType", "byStatus", "topEcosystems", "lastUpdatedAt"],
    properties: {
      total: { type: "integer" },
      byFundingType: { type: "object", additionalProperties: { type: "integer" } },
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
    additionalProperties: true,
    description:
      "The canonical RFP Hub Standard JSON Schema document itself (JSON Schema draft 2020-12), served verbatim as application/schema+json. It self-identifies through its own $id and $schema members, so no envelope carries the version. Those two members are deliberately NOT declared as properties here: `$id` inside a registered component is read as a schema identifier by the OpenAPI ref resolver.",
    required: ["title", "type"],
    properties: {
      title: { type: "string", description: "Human-readable name of the schema." },
      type: { type: "string", description: "The JSON Schema `type` of an opportunity: object." },
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
    additionalProperties: false,
    required: ["error", "message"],
    properties: {
      error: { type: "string", description: "Stable machine-readable error code (snake_case)." },
      message: { type: "string", description: "Human-readable detail." },
    },
  },
] as const;
