/**
 * Reusable response schemas, registered on the Fastify instance so both the OpenAPI 3.1 document
 * (served at /v1/docs/json) and the response serializer reference them by `$ref`.
 *
 * The two opportunity components are DERIVED from `@the-rfp-hub/standard` (see ./standard.ts):
 * every property, enum, format and the `required` list come out of the canonical JSON Schema at
 * module load, so the published contract cannot drift from the Standard. Only what the Standard
 * cannot know is written by hand here — the list/detail split, and the components that are not
 * part of the Standard at all (Stats, Health, ErrorResponse, …).
 *
 * `Opportunity` uses `additionalProperties: true` on purpose: the serializer must pass a full
 * Standard object through untouched, so a Standard that grows a field keeps serving it (the
 * drift-guard test in test/unit/openapi-drift.test.ts is what makes sure it also gets DOCUMENTED).
 * `OpportunitySummary` is the opposite case — a server-controlled projection with a closed shape.
 */
import { STANDARD_REQUIRED, detailOnly, standardEnum, standardProperty } from "./standard.js";

/** Every property `toSummary` emits — the fields shared by the list and detail projections. */
const summaryProperties = {
  specVersion: standardProperty("specVersion"),
  id: standardProperty("id"),
  fundingType: standardProperty("fundingType"),
  title: standardProperty("title"),
  description: standardProperty("description"),
  summary: standardProperty("summary"),
  status: standardProperty("status"),
  sponsoringOrganizations: standardProperty("sponsoringOrganizations"),
  operatingOrganizations: standardProperty("operatingOrganizations"),
  source: standardProperty("source"),
  ecosystems: standardProperty("ecosystems"),
  networks: standardProperty("networks"),
  categories: standardProperty("categories"),
  tags: standardProperty("tags"),
  eligibility: standardProperty("eligibility"),
  prerequisites: standardProperty("prerequisites"),
  resourceLinks: standardProperty("resourceLinks"),
  serviceAgreement: standardProperty("serviceAgreement"),
  applicationUrl: standardProperty("applicationUrl"),
  website: standardProperty("website"),
  logoUrl: standardProperty("logoUrl"),
  bannerUrl: standardProperty("bannerUrl"),
  socialLinks: standardProperty("socialLinks"),
  funding: standardProperty("funding"),
  milestones: standardProperty("milestones"),
  opensAt: standardProperty("opensAt"),
  deadlines: standardProperty("deadlines"),
  postedAt: standardProperty("postedAt"),
  createdAt: standardProperty("createdAt"),
  updatedAt: standardProperty("updatedAt"),
};

/**
 * The six type-specific blocks, keyed by `fundingType` value. Exactly one is present on any given
 * entry — which one is a runtime fact (`opportunity[opportunity.fundingType]`), so all six are
 * declared as optional properties rather than modelled as a union.
 */
const typeBlockProperties = Object.fromEntries(
  standardEnum("fundingType").map((type) => [type, detailOnly(standardProperty(type))]),
);

export const responseSchemas: ({ $id: string } & Record<string, unknown>)[] = [
  {
    $id: "Opportunity",
    type: "object",
    description:
      "A full RFP Hub Standard opportunity, as served by GET /v1/opportunities/{id}: the shared fields plus the block named by `fundingType` and any publisher `extensions`.",
    additionalProperties: true,
    required: [...STANDARD_REQUIRED],
    properties: {
      ...summaryProperties,
      ...typeBlockProperties,
      extensions: detailOnly(standardProperty("extensions")),
    },
  },
  {
    $id: "OpportunitySummary",
    type: "object",
    description:
      "The thin list projection served by GET /v1/opportunities: a Standard opportunity minus the type-specific block and `extensions`. Fetch the detail endpoint for those.",
    additionalProperties: false,
    required: [...STANDARD_REQUIRED],
    properties: { ...summaryProperties },
  },
  {
    $id: "PaginatedOpportunities",
    type: "object",
    additionalProperties: false,
    required: ["items", "page", "limit", "total", "totalPages"],
    properties: {
      items: { type: "array", items: { $ref: "OpportunitySummary" } },
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
];
