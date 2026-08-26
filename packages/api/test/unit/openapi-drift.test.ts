/**
 * DRIFT GUARD for the served OpenAPI response components.
 *
 * The published spec is only worth anything if it describes what the API actually emits, so this
 * test diffs the two opportunity components against the ONLY two sources that can move:
 *
 * 1. the mapper — every committed Standard example (schemas/v1.0.0/examples + the conformance
 *    `pass` fixtures) is pushed through `fromStandard` → row → `toStandard`/`toSummary`, and the
 *    union of the keys that come out must equal the properties the components declare. A field
 *    added to the mapper and not to the spec fails here, and so does a property declared in the
 *    spec that nothing ever emits;
 * 2. the Standard — the enums and the `required` list the components publish must be the
 *    Standard's own, byte for byte, on the RESPONSE side AND on the request side (the list
 *    endpoint's fundingType/status filters, whose drift a client sees as a hard 400).
 *
 * The components that close their shape with `additionalProperties: false` get a third guard: a
 * field a service starts returning is silently DROPPED by fast-json-stringify, so the "live spec"
 * assertions in test/integration/openapi.test.ts cannot see it — they validate a body the
 * serializer has already coerced to the very schema under test. The samples below are typed as
 * the producer's own return type, so adding a field there fails the typecheck until it is
 * declared here too.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Opportunity, opportunitySchema } from "@the-rfp-hub/standard";
import { describe, expect, it } from "vitest";
import type { OpportunityRow } from "../../src/db/schema.js";
import {
  type OpportunityInsertData,
  type OpportunitySummary,
  fromStandard,
  toStandard,
  toSummary,
} from "../../src/modules/mappers/opportunity.mapper.js";
import { listQuerySchema } from "../../src/modules/routes/opportunities/types.js";
import type { Page } from "../../src/modules/services/opportunities/opportunity.service.js";
import type { StatsSummary } from "../../src/modules/services/stats/stats.service.js";
import type {
  AccountListView,
  AccountSummaryView,
  ApiKeyCreatedView,
  ApiKeyListView,
  ApiKeyView,
  AuditEntryView,
  AuditTrailView,
  ClaimListView,
  ClaimResultView,
  ClaimSummaryView,
  DuplicateListView,
  DuplicateMatchView,
  DuplicatePairListView,
  DuplicatePairView,
  DuplicateSideView,
  InsightsEntryView,
  InsightsPointView,
  InsightsSeriesView,
  InsightsSummaryView,
  InsightsTotalsView,
  JobRunResultView,
  ManagedOpportunityListView,
  ManagedOpportunityView,
  MeMembershipView,
  MeView,
  MembershipResultView,
  MergeResultView,
  OrganizationListView,
  OrganizationSummaryView,
  OwnedDuplicateListView,
  OwnedDuplicateMatchView,
  PublisherListView,
  PublisherView,
  ReviewDecisionView,
  SubmissionResultView,
  VerificationRunView,
} from "../../src/modules/shared/api-views.js";
import { canonicalDocuments } from "../../src/modules/shared/canonical-documents.js";
import { type ExportEnvelope, toExportJson } from "../../src/modules/shared/export-format.js";
import { responseSchemas } from "../../src/openapi/schemas.js";

type JsonSchema = Record<string, unknown>;

const standard = opportunitySchema as JsonSchema;
const standardProperties = standard.properties as Record<string, JsonSchema>;

function standardProperty(name: string): JsonSchema {
  const schema = standardProperties[name];
  if (!schema) throw new Error(`the Standard has no top-level '${name}' property`);
  return schema;
}

const byId = new Map(responseSchemas.map((schema) => [schema.$id, schema as JsonSchema]));

function component(id: string): JsonSchema {
  const schema = byId.get(id);
  if (!schema) throw new Error(`no response component '${id}' is registered`);
  return schema;
}

function propertiesOf(id: string): Record<string, JsonSchema> {
  return component(id).properties as Record<string, JsonSchema>;
}

function declaredProperty(id: string, name: string): JsonSchema {
  const schema = propertiesOf(id)[name];
  if (!schema) throw new Error(`component '${id}' declares no '${name}' property`);
  return schema;
}

function declaredKeys(id: string): string[] {
  return Object.keys(propertiesOf(id)).sort();
}

/** Both committed fixture sets: the published examples and the conformance `pass` corpus. */
const FIXTURE_DIRS = [
  "../../../standard/schemas/v1.0.0/examples",
  "../../../standard/conformance/v1.0.0/pass",
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

function loadFixtures(): { file: string; opp: Opportunity }[] {
  return FIXTURE_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, opp: JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) })),
  );
}

/** Build a DB row equivalent to what the seed would store, to drive the read mappers. */
function rowFromInsert(opp: OpportunityInsertData): OpportunityRow {
  return {
    ...opp,
    id: 1,
    reviewStatus: "approved",
    isListed: true,
    sourceSystem: null,
    createdAt: opp.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: opp.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  } as OpportunityRow;
}

const fixtures = loadFixtures();
const rows = fixtures.map(({ file, opp }) => ({ file, row: rowFromInsert(fromStandard(opp).opp) }));

/** Every key the mapper emits across the whole committed corpus. */
function emittedKeys(project: (row: OpportunityRow) => object): Set<string> {
  const keys = new Set<string>();
  for (const { row } of rows) for (const key of Object.keys(project(row))) keys.add(key);
  return keys;
}

describe("OpenAPI components vs the mapper (drift guard)", () => {
  it("loads the committed corpus", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
  });

  it("declares exactly the keys `toSummary` emits", () => {
    expect(declaredKeys("OpportunitySummary")).toEqual([...emittedKeys(toSummary)].sort());
  });

  it("declares exactly the keys `toStandard` emits", () => {
    // Every entry emits the same `fundingDetails` slot (the union is inside it), so the corpus
    // covers the full detail shape directly — no per-type special case needed.
    expect(declaredKeys("Opportunity")).toEqual([...emittedKeys(toStandard)].sort());
  });

  for (const { file, row } of rows) {
    it(`documents every key ${file} produces`, () => {
      expect(declaredKeys("Opportunity")).toEqual(
        expect.arrayContaining(Object.keys(toStandard(row))),
      );
      expect(declaredKeys("OpportunitySummary")).toEqual(
        expect.arrayContaining(Object.keys(toSummary(row))),
      );
    });
  }

  it("keeps the list projection thin: no fundingDetails", () => {
    const summary = declaredKeys("OpportunitySummary");
    expect(summary).not.toContain("fundingDetails");
    expect(component("OpportunitySummary").additionalProperties).toBe(false);
  });

  it("points the paginated envelope at the summary projection", () => {
    const items = propertiesOf("PaginatedOpportunities").items as JsonSchema;
    expect((items.items as JsonSchema).$ref).toBe("OpportunitySummary");
  });
});

describe("OpenAPI components vs the Standard (derivation guard)", () => {
  for (const id of ["Opportunity", "OpportunitySummary"]) {
    it(`${id} publishes the Standard's enums`, () => {
      for (const name of ["fundingType", "status"]) {
        expect(declaredProperty(id, name).enum, `${id}.${name}`).toEqual(
          standardProperty(name).enum,
        );
      }
    });

    it(`${id} requires exactly what the Standard requires`, () => {
      // The summary is the one deliberate deviation: it omits `fundingDetails` (a delivery
      // projection), so it cannot require it. Everything else tracks the Standard byte for byte.
      const expected =
        id === "OpportunitySummary"
          ? (standard.required as string[]).filter((name) => name !== "fundingDetails")
          : standard.required;
      expect(component(id).required).toEqual(expected);
    });

    it(`${id} declares only Standard properties`, () => {
      expect(Object.keys(standardProperties)).toEqual(expect.arrayContaining(declaredKeys(id)));
      // Document-level self-identification describes the document, not the opportunity: the
      // mapper strips it, so the served components must not advertise it.
      for (const name of ["$schema", "@context", "@type"]) {
        expect(declaredKeys(id)).not.toContain(name);
      }
    });
  }

  it("carries the Standard's types and formats", () => {
    const served = propertiesOf("Opportunity");
    for (const [name, schema] of Object.entries(standardProperties)) {
      if (!served[name]) continue;
      if (schema.type) expect(served[name].type, `${name}.type`).toEqual(schema.type);
      if (schema.format) expect(served[name].format, `${name}.format`).toBe(schema.format);
    }
  });
});

describe("the REQUEST contract vs the Standard (list filters)", () => {
  const filters = {
    fundingType: listQuerySchema.properties.fundingType,
    status: listQuerySchema.properties.status,
  };

  for (const [name, filter] of Object.entries(filters)) {
    const values = standardProperty(name).enum as string[];

    it(`${name} accepts exactly the Standard's values, alone and as a comma list`, () => {
      const pattern = new RegExp(filter.items.pattern);
      for (const value of values) {
        expect(pattern.test(value), `${name}=${value}`).toBe(true);
        expect(filter.description, `${name} documents ${value}`).toContain(value);
      }
      expect(pattern.test(values.join(",")), `${name}=<all>`).toBe(true);
      // …and nothing else: an out-of-Standard value is what the 400 exists for
      expect(pattern.test("not-a-real-value")).toBe(false);
      expect(pattern.test(`${values[0]},not-a-real-value`)).toBe(false);
    });

    // Empty values are what URLSearchParams-style builders and HTML forms emit for an unselected
    // filter. `ecosystem`/`category`/`q` have always accepted them; these two must not be the
    // exception.
    it(`${name} accepts an empty value, like every other list filter`, () => {
      const pattern = new RegExp(filter.items.pattern);
      expect(pattern.test("")).toBe(true);
      expect(pattern.test("   ")).toBe(true);
    });
  }
});

/**
 * Closed components (`additionalProperties: false`): the serializer DROPS anything not declared
 * here, silently. Each sample is typed as the producer's own return type — a new field there is a
 * typecheck error until it is added to the sample, and then a test failure until it is declared.
 */
describe("closed response components vs their producers", () => {
  const closed = responseSchemas
    .filter((schema) => schema.additionalProperties === false)
    .map((schema) => schema.$id)
    .sort();

  it("guards every component that closes its shape", () => {
    expect(closed).toEqual([
      "AccountList",
      "AccountSummary",
      "ApiKey",
      "ApiKeyCreated",
      "ApiKeyList",
      "AuditEntry",
      "AuditTrail",
      "ClaimList",
      "ClaimResult",
      "ClaimSummary",
      "DatasetExport",
      "DuplicateList",
      "DuplicateMatch",
      "DuplicatePair",
      "DuplicatePairList",
      "DuplicateSide",
      "ErrorResponse",
      "Health",
      "InsightsEntry",
      "InsightsPoint",
      "InsightsSeries",
      "InsightsSummary",
      "InsightsTotals",
      "JobRunResult",
      "ManagedOpportunity",
      "ManagedOpportunityList",
      "Me",
      "MeMembership",
      "MembershipResult",
      "MergeResult",
      "MergedOpportunityErrorResponse",
      "OpportunitySummary", // covered field-by-field by the mapper drift guard above
      "OrganizationList",
      "OrganizationSummary",
      "OwnedDuplicateList",
      "OwnedDuplicateMatch",
      "PaginatedOpportunities",
      "Publisher",
      "PublisherList",
      "ReviewDecision",
      "Stats",
      "SubmissionResult",
      "ValidationErrorResponse",
      "VerificationRun",
    ]);
  });

  /**
   * The canonical spec documents are the Standard's own bytes, so their components are
   * deliberately OPEN — a closed component would let fast-json-stringify drop a member of a
   * document the API does not own. What can drift is the pairing: a document added without a
   * component, or a component whose `required` members are not actually in the served bytes.
   */
  it("declares an open component for every canonical spec document", () => {
    for (const doc of canonicalDocuments) {
      const schema = component(doc.component);
      expect(schema.additionalProperties, doc.component).toBe(true);
      const body = JSON.parse(doc.body.toString("utf8")) as Record<string, unknown>;
      for (const name of (schema.required as string[]) ?? []) {
        expect(body[name], `${doc.source} is missing the declared '${name}'`).toBeDefined();
      }
    }
  });

  // The media types ARE the interoperability contract: a JSON Schema document served as
  // application/json is not `$ref`-able by a generic validator, and a context served as
  // anything but ld+json is not a context.
  it("serves each canonical document under the media type its kind requires", () => {
    const expected: Record<string, string> = {
      "/schemas/v1.0.0/opportunity.schema.json": "application/schema+json",
      "/schemas/v1.0.0/context.jsonld": "application/ld+json",
      "/schemas/index.json": "application/json",
      "/meta/rfphub-schema.meta.json": "application/schema+json",
      "/registries/entry.schema.json": "application/schema+json",
    };
    expect(Object.fromEntries(canonicalDocuments.map((d) => [d.path, d.mediaType]))).toEqual(
      expected,
    );
  });

  /**
   * The export envelope is the one component that is ALSO a published file format: the same five
   * keys are what `exports/latest.json` carries. A field added to `ExportEnvelope` therefore
   * changes the open data as well as the API, and has to be declared in both places — this is what
   * makes the second half impossible to forget.
   */
  it("DatasetExport declares exactly what the export format emits", () => {
    const sample: ExportEnvelope = {
      specVersion: "1.0.0",
      license: "CC0-1.0",
      generatedAt: "2026-08-13T09:41:00.000Z",
      count: 0,
      opportunities: [],
    };
    expect(declaredKeys("DatasetExport")).toEqual(Object.keys(sample).sort());
    // …and the same keys really do come out of the serializer, not just out of the type.
    expect(declaredKeys("DatasetExport")).toEqual(
      Object.keys(JSON.parse(toExportJson([], sample.generatedAt))).sort(),
    );

    // Records are documented as the SAME component the detail endpoint serves, not a copy of it.
    const records = propertiesOf("DatasetExport").opportunities as JsonSchema;
    expect((records.items as JsonSchema).$ref).toBe("Opportunity");
  });

  it("Stats declares exactly what StatsService.summary() returns", () => {
    const sample: StatsSummary = {
      total: 0,
      byFundingType: {},
      byStatus: {},
      topEcosystems: [{ ecosystem: "Optimism", count: 1 }],
      lastUpdatedAt: null,
    };
    expect(declaredKeys("Stats")).toEqual(Object.keys(sample).sort());

    const topEcosystems = propertiesOf("Stats").topEcosystems as JsonSchema;
    const item = topEcosystems.items as JsonSchema;
    expect(Object.keys(item.properties as object).sort()).toEqual(
      Object.keys(sample.topEcosystems[0] as object).sort(),
    );
  });

  it("PaginatedOpportunities declares exactly what the list service returns", () => {
    const sample: Page<OpportunitySummary> = {
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    };
    expect(declaredKeys("PaginatedOpportunities")).toEqual(Object.keys(sample).sort());
  });

  // health.controller.ts and app.ts's error handler emit object literals rather than a named type,
  // so these two are pinned to the literals they send.
  it("Health and ErrorResponse declare exactly what their controllers send", () => {
    expect(declaredKeys("Health")).toEqual(
      Object.keys({ status: "ok", db: "up", auth: { google: false } }).sort(),
    );
    expect(declaredKeys("ErrorResponse")).toEqual(
      Object.keys({ error: "bad_request", message: "…" }).sort(),
    );
  });
});

/**
 * The M3 components, each pinned to the type its producer actually returns.
 *
 * Every one of these closes its shape, so fast-json-stringify DROPS an undeclared member without a
 * word — and the live-spec integration test cannot see that, because it validates a body the
 * serializer has already coerced to the very schema under test. The samples below are typed as the
 * view interfaces the controllers return (`modules/shared/api-views.ts`), so adding a field there
 * is a TYPECHECK error until the sample is updated, and then a TEST failure until the component
 * declares it.
 */
describe("M3 closed components vs their view types", () => {
  const duplicateMatchSample: DuplicateMatchView = {
    id: "example-org:other",
    title: "Other",
    isPublic: true,
    similarity: 0.91,
    status: "suspected",
    detectedAt: "2026-08-14T00:00:00.000Z",
  };
  const submissionResult: SubmissionResultView = {
    opportunity: fixtures[0]?.opp as Opportunity,
    created: true,
    reviewStatus: "pending",
    isListed: true,
    warnings: [],
    duplicateCheck: "ok",
    duplicates: [duplicateMatchSample],
  };
  const auditEntry: AuditEntryView = {
    action: "update",
    at: "2026-08-14T00:00:00.000Z",
    actorKind: "api_key",
    actor: "example-org",
    changedFields: ["title"],
    patch: { title: { before: "a", after: "b" } },
  };
  const duplicateMatch: DuplicateMatchView = duplicateMatchSample;
  const ownedDuplicateMatch: OwnedDuplicateMatchView = {
    ...duplicateMatch,
    yourListing: { id: "example-org:mine", title: "Mine" },
  };
  const duplicateSide: DuplicateSideView = {
    id: "example-org:one",
    title: "One",
    reviewStatus: "approved",
    isListed: true,
    namespace: "example-org",
    mergedInto: null,
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  const duplicatePair: DuplicatePairView = {
    id: 1,
    status: "suspected",
    similarity: 0.91,
    detectedAt: "2026-08-14T00:00:00.000Z",
    reviewedAt: null,
    left: duplicateSide,
    right: { ...duplicateSide, id: "example-org:two", title: "Two" },
  };
  const verificationRun: VerificationRunView = {
    runAt: "2026-08-14T00:00:00.000Z",
    requestedUrl: "https://example.org/apply",
    finalUrl: "https://example.org/apply",
    httpStatus: 200,
    existsAtSource: true,
    matched: true,
    fieldDiff: {},
    extracted: {},
    snapshotSha256: "0".repeat(64),
    error: null,
  };
  const claimResult: ClaimResultView = {
    outcome: "granted",
    claimId: 1,
    opportunityId: "example-org:one",
    organizationSlug: "example-org",
    message: "…",
  };
  const claimSummary: ClaimSummaryView = {
    id: 1,
    opportunityId: "example-org:one",
    opportunityTitle: "One",
    organizationSlug: "example-org",
    organizationVerified: true,
    claimedBy: "someone",
    claimedByAccountId: 1,
    status: "pending",
    note: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    decidedAt: null,
  };
  const insightsTotals: InsightsTotalsView = {
    listViews: 12,
    detailViews: 3,
    sourceClicks: 1,
    applyClicks: 2,
  };
  const insightsPoint: InsightsPointView = { day: "2026-08-14", ...insightsTotals };
  const insightsEntry: InsightsEntryView = {
    opportunityId: "example-org:one",
    title: "One",
    ...insightsTotals,
  };
  const publisher: PublisherView = {
    slug: "example-org",
    name: "Example",
    description: null,
    website: null,
    logoUrl: null,
    ecosystems: [],
    verifiedAt: null,
  };
  const meMembership: MeMembershipView = {
    slug: "example-org",
    name: "Example",
    role: "owner",
    verified: true,
  };
  const me: MeView = {
    accountId: 1,
    handle: null,
    displayName: null,
    email: null,
    role: "submitter",
    directCreate: false,
    credentialKind: "session",
    scopes: [],
    memberships: [meMembership],
    canManageKeys: true,
    canReview: false,
    canAdmin: false,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
  const apiKey: ApiKeyView = {
    id: 1,
    name: null,
    keyPrefix: "abcdefgh",
    scopes: ["read"],
    createdAt: "2026-08-14T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
  const managed: ManagedOpportunityView = {
    id: "example-org:one",
    title: "One",
    fundingType: "grant",
    status: "open",
    reviewStatus: "pending",
    isListed: true,
    namespace: "example-org",
    submittedBy: null,
    submittedByAccountId: 1,
    mergedInto: null,
    // Null is the state most entries are in — nobody has decided anything yet. The populated shape
    // is asserted end to end in review.test.ts, where a real decision produces it.
    lastDecision: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  const accountSummary: AccountSummaryView = {
    id: 1,
    handle: null,
    displayName: null,
    email: "person@example.com",
    globalRole: "submitter",
    directCreate: false,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
  const organizationSummary: OrganizationSummaryView = {
    slug: "example-org",
    name: "Example",
    verified: true,
    verifiedAt: null,
    website: null,
    ecosystems: [],
    memberCount: 1,
  };

  const samples: Record<string, object> = {
    SubmissionResult: submissionResult,
    AuditEntry: auditEntry,
    AuditTrail: { entries: [auditEntry] } satisfies AuditTrailView,
    DuplicateMatch: duplicateMatch,
    DuplicateList: { items: [duplicateMatch] } satisfies DuplicateListView,
    OwnedDuplicateMatch: ownedDuplicateMatch,
    OwnedDuplicateList: { items: [ownedDuplicateMatch] } satisfies OwnedDuplicateListView,
    DuplicateSide: duplicateSide,
    DuplicatePair: duplicatePair,
    DuplicatePairList: { items: [duplicatePair] } satisfies DuplicatePairListView,
    MergeResult: {
      pair: duplicatePair,
      survivorId: "example-org:one",
      mergedId: "example-org:two",
      copiedFields: [],
    } satisfies MergeResultView,
    VerificationRun: verificationRun,
    InsightsTotals: insightsTotals,
    InsightsPoint: insightsPoint,
    InsightsEntry: insightsEntry,
    InsightsSeries: {
      opportunityId: "example-org:one",
      title: "One",
      from: "2026-07-16",
      to: "2026-08-14",
      totals: insightsTotals,
      days: [insightsPoint],
    } satisfies InsightsSeriesView,
    InsightsSummary: {
      from: "2026-07-16",
      to: "2026-08-14",
      totals: insightsTotals,
      opportunities: [insightsEntry],
    } satisfies InsightsSummaryView,
    // Every member present, including the two the runner omits when they do not apply: a closed
    // component that never declared them would silently drop `skipped` from the one response a
    // reader most needs it in.
    JobRunResult: {
      job: "staleness",
      shape: "cursor",
      processed: 3,
      remaining: 0,
      skipped: "locked",
      passes: 1,
      elapsedMs: 12,
      details: { closedPastDue: 3 },
    } satisfies JobRunResultView,
    ClaimResult: claimResult,
    ClaimSummary: claimSummary,
    ClaimList: { items: [claimSummary] } satisfies ClaimListView,
    Publisher: publisher,
    PublisherList: { items: [publisher], total: 1 } satisfies PublisherListView,
    MeMembership: meMembership,
    Me: me,
    ApiKey: apiKey,
    ApiKeyList: { items: [apiKey] } satisfies ApiKeyListView,
    ApiKeyCreated: { key: apiKey, token: "rfph_abcdefgh_secret" } satisfies ApiKeyCreatedView,
    ManagedOpportunity: managed,
    ManagedOpportunityList: {
      items: [managed],
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    } satisfies ManagedOpportunityListView,
    ReviewDecision: {
      id: "example-org:one",
      reviewStatus: "approved",
      isListed: true,
    } satisfies ReviewDecisionView,
    AccountSummary: accountSummary,
    AccountList: { items: [accountSummary] } satisfies AccountListView,
    OrganizationSummary: organizationSummary,
    OrganizationList: { items: [organizationSummary] } satisfies OrganizationListView,
    MembershipResult: {
      organizationSlug: "example-org",
      accountId: 1,
      role: "publisher",
      member: true,
    } satisfies MembershipResultView,
    MergedOpportunityErrorResponse: {
      error: "opportunity_merged",
      mergedInto: { id: "example-org:survivor", title: "The survivor" },
    },
    // Not a view type: the error body is assembled by `HttpError.toBody()`.
    ValidationErrorResponse: {
      error: "validation_failed",
      message: "…",
      errors: ["…"],
      issues: [{ path: "/title", message: "is required" }],
    },
  };

  for (const [id, sample] of Object.entries(samples)) {
    it(`${id} declares exactly what its producer returns`, () => {
      expect(declaredKeys(id)).toEqual(Object.keys(sample).sort());
    });
  }

  it("covers every closed M3 component with a typed sample", () => {
    const m3 = responseSchemas
      .filter((schema) => schema.additionalProperties === false)
      .map((schema) => schema.$id)
      .filter(
        (id) =>
          ![
            "DatasetExport",
            "ErrorResponse",
            "Health",
            "OpportunitySummary",
            "PaginatedOpportunities",
            "Stats",
          ].includes(id),
      )
      .sort();
    expect(Object.keys(samples).sort()).toEqual(m3);
  });
});
