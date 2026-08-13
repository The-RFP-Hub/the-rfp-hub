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
import { STANDARD_REQUIRED, detailOnly, standardProperty } from "./standard.js";

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
  categories: standardProperty("categories"),
  eligibility: standardProperty("eligibility"),
  prerequisites: standardProperty("prerequisites"),
  additionalReferences: standardProperty("additionalReferences"),
  serviceAgreement: standardProperty("serviceAgreement"),
  applicationUrl: standardProperty("applicationUrl"),
  website: standardProperty("website"),
  logoUrl: standardProperty("logoUrl"),
  bannerUrl: standardProperty("bannerUrl"),
  socialLinks: standardProperty("socialLinks"),
  fundingInfo: standardProperty("fundingInfo"),
  milestones: standardProperty("milestones"),
  opensAt: standardProperty("opensAt"),
  deadlines: standardProperty("deadlines"),
  postedAt: standardProperty("postedAt"),
  createdAt: standardProperty("createdAt"),
  updatedAt: standardProperty("updatedAt"),
};

/**
 * The type-specific details, a single required slot: the Standard models `fundingDetails` as a
 * `oneOf` tagged union over the six detail shapes, each self-described by its required
 * `fundingType` tag (equal to the top-level `fundingType`). The derivation serves it as a
 * pass-through object, like every other `$defs`-backed sub-object.
 */
const fundingDetailsProperty = detailOnly(standardProperty("fundingDetails"));

export const responseSchemas: ({ $id: string } & Record<string, unknown>)[] = [
  {
    $id: "Opportunity",
    type: "object",
    description:
      "A full RFP Hub Standard opportunity, as served by GET /v1/opportunities/{id}: the shared fields plus `fundingDetails`, whose own `fundingType` tag names its shape.",
    additionalProperties: true,
    required: [...STANDARD_REQUIRED],
    properties: {
      ...summaryProperties,
      fundingDetails: fundingDetailsProperty,
    },
  },
  {
    $id: "OpportunitySummary",
    type: "object",
    description:
      "The thin list projection served by GET /v1/opportunities: a Standard opportunity minus `fundingDetails`. Fetch the detail endpoint for that.",
    additionalProperties: false,
    // The Standard requires `fundingDetails`; the summary is the one deliberate deviation — it is
    // a server-controlled projection that omits that slot, so it cannot require it either.
    required: STANDARD_REQUIRED.filter((name) => name !== "fundingDetails"),
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
    $id: "JsonLdContext",
    type: "object",
    additionalProperties: true,
    description:
      "The RFP Hub Standard's JSON-LD context document, served verbatim as application/ld+json at its canonical URL. Its single top-level member is `@context`; the term mappings inside it are the Standard's, not this API's.",
    required: ["@context"],
    properties: {
      "@context": {
        type: "object",
        additionalProperties: true,
        description: "Term definitions mapping every Standard field to an IRI.",
      },
    },
  },
  {
    $id: "SpecVersionIndex",
    type: "object",
    additionalProperties: true,
    description:
      "Machine-readable index of published RFP Hub Standard versions, served verbatim at its canonical URL. `latest` names the current spec version; each entry's `path` is a sibling directory of the index.",
    required: ["versions", "latest"],
    properties: {
      versions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["version", "path", "status"],
          properties: {
            version: { type: "string", description: "The spec version, e.g. 1.0.0." },
            path: { type: "string", description: "Directory holding that version's artifacts." },
            status: { type: "string", description: "Maturity: draft or stable." },
          },
        },
      },
      latest: { type: "string", description: "The current spec version." },
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
