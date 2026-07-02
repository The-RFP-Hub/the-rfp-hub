import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import type { OpportunityRow, OrganizationInsert, OrganizationRow } from "../../src/db/schema.js";
import {
  type OpportunityInsertData,
  fromStandard,
  toStandard,
  toSummary,
} from "../../src/modules/mappers/opportunity.mapper.js";

const EXAMPLES_DIR = fileURLToPath(
  new URL("../../../standard/schemas/v1.0.0/examples", import.meta.url),
);

function loadExamples(): { file: string; opp: Opportunity }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, opp: JSON.parse(readFileSync(`${EXAMPLES_DIR}/${file}`, "utf8")) }));
}

/** Build a DB row equivalent to what the seed would store, to drive the read mapper. */
function rowFromInsert(opp: OpportunityInsertData): OpportunityRow {
  return {
    ...opp,
    id: 1,
    organizationId: 1,
    reviewStatus: "approved",
    isListed: true,
    sourceSystem: null,
    createdAt: opp.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: opp.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  } as OpportunityRow;
}

function orgRowFromInsert(org: OrganizationInsert): OrganizationRow {
  return {
    id: 1,
    type: null,
    description: null,
    website: null,
    logoUrl: null,
    bannerUrl: null,
    socialLinks: {},
    ecosystems: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...org,
  } as OrganizationRow;
}

/** Recursively drop null-valued keys (the mapper omits nulls; some examples spell them out). */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Treat null ≡ omitted, and ignore Hub-managed timestamps + the synthesized org slug — none of
 * which are part of the data the mappers must preserve.
 */
function omitKeys(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function normalize(o: Opportunity): Record<string, unknown> {
  const c = stripNulls(JSON.parse(JSON.stringify(o))) as Record<string, unknown>;
  const top = omitKeys(c, ["createdAt", "updatedAt"]);
  if (top.organization && typeof top.organization === "object") {
    top.organization = omitKeys(top.organization as Record<string, unknown>, ["slug"]);
  }
  return top;
}

describe("opportunity.mapper round-trip (Standard → row → Standard)", () => {
  const examples = loadExamples();

  it("loads the committed examples", () => {
    expect(examples.length).toBeGreaterThanOrEqual(20);
  });

  for (const { file, opp } of examples) {
    it(`reproduces ${file} through fromStandard → toStandard`, () => {
      const { org, opp: insert } = fromStandard(opp);
      const rebuilt = toStandard(rowFromInsert(insert), orgRowFromInsert(org));
      expect(validateOpportunity(rebuilt).valid).toBe(true);
      expect(normalize(rebuilt)).toEqual(normalize(opp));
    });
  }
});

describe("read projections", () => {
  const row: OpportunityRow = rowFromInsert(
    fromStandard({
      specVersion: "1.0.0",
      id: "x:1",
      type: "grant",
      title: "T",
      description: "D",
      status: "open",
      organization: { name: "Org", slug: "org" },
      source: { url: "https://example.com", ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: ["Optimism"],
      grant: { recurring: true },
      extensions: { "x.foo": 1 },
    }).opp,
  );
  const org = orgRowFromInsert({ slug: "org", name: "Org" });

  it("toStandard includes the type block and extensions", () => {
    const full = toStandard(row, org);
    expect(full.grant).toEqual({ recurring: true });
    expect(full.extensions).toEqual({ "x.foo": 1 });
  });

  it("toSummary omits the type block and extensions but keeps core fields", () => {
    const thin = toSummary(row, org) as Record<string, unknown>;
    expect(thin.grant).toBeUndefined();
    expect(thin.extensions).toBeUndefined();
    expect(thin.id).toBe("x:1");
    expect(thin.ecosystems).toEqual(["Optimism"]);
  });
});
