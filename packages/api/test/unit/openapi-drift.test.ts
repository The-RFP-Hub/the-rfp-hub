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
import { canonicalDocuments } from "../../src/modules/shared/canonical-documents.js";
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
      "ErrorResponse",
      "Health",
      "OpportunitySummary", // covered field-by-field by the mapper drift guard above
      "PaginatedOpportunities",
      "Stats",
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
    expect(declaredKeys("Health")).toEqual(Object.keys({ status: "ok", db: "up" }).sort());
    expect(declaredKeys("ErrorResponse")).toEqual(
      Object.keys({ error: "bad_request", message: "…" }).sort(),
    );
  });
});
