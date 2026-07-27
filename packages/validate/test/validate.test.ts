import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertOpportunity, humanizeErrors, validateOpportunity } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const standard = join(here, "..", "..", "standard");
const conformance = join(standard, "conformance", "v1.0.0");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const loadDir = (d: string) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, data: readJson(join(d, f)) }));

/**
 * The conformance suite is the contract, and it lives in @rfp-hub/standard so that an
 * external implementer can run the same cases. Every file is named after the rule it
 * exercises, so a red run here names the violated constraint directly.
 */
describe("conformance suite — pass/", () => {
  const cases = loadDir(join(conformance, "pass"));

  it("covers the cases the re-cut is required to accept", () => {
    const names = cases.map((c) => c.name);
    expect(names).toContain("minimal-required-only.json");
    expect(names).toContain("source-empty-object.json");
    expect(names).toContain("self-identification.json");
    expect(names).toContain("full-featured.json");
  });

  for (const { name, data } of cases) {
    it(`accepts ${name}`, () => {
      const { valid, errors } = validateOpportunity(data);
      if (!valid) console.error(humanizeErrors(errors));
      expect(valid).toBe(true);
    });
  }
});

describe("conformance suite — fail/", () => {
  const cases = loadDir(join(conformance, "fail"));

  it("covers the cases the re-cut is required to reject", () => {
    const names = cases.map((c) => c.name);
    expect(names).toContain("one-block-per-fundingtype.json");
    expect(names).toContain("deadline-fixed-without-date.json");
    expect(names).toContain("deadline-fixed-date-null.json");
    expect(names).toContain("missing-sponsoring-organizations.json");
    expect(names).toContain("unknown-top-level-property.json");
    expect(names).toContain("wrong-fundingtype-value.json");
  });

  for (const { name, data } of cases) {
    it(`rejects ${name}`, () => {
      const { valid, errors } = validateOpportunity(data);
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(humanizeErrors(errors).every((l) => typeof l === "string")).toBe(true);
    });
  }
});

/** D20 in both directions: the matching block is required AND every other one is forbidden. */
describe("one block per fundingType (D20)", () => {
  const base = {
    specVersion: "1.0.0",
    id: "d20",
    title: "T",
    description: "D",
    status: "open" as const,
    sponsoringOrganizations: [{ name: "Org" }],
    source: {},
  };

  it("accepts the matching block alone", () => {
    expect(validateOpportunity({ ...base, fundingType: "grant", grant: {} }).valid).toBe(true);
  });

  it("rejects a matching block plus any other block", () => {
    for (const extra of ["hackathon", "bounty", "accelerator", "vc_fund", "rfp"]) {
      const doc = { ...base, fundingType: "grant", grant: {}, [extra]: {} };
      expect(validateOpportunity(doc).valid, `grant + ${extra} must fail`).toBe(false);
    }
  });

  it("rejects a non-matching block on its own", () => {
    expect(validateOpportunity({ ...base, fundingType: "grant", rfp: {} }).valid).toBe(false);
  });
});

describe("validateOpportunity", () => {
  it("rejects an unsupported spec", () => {
    expect(() => validateOpportunity({}, { spec: "9.9.9" })).toThrow(/unsupported spec/);
  });

  it("pins specVersion to the one version this schema defines", () => {
    const doc = readJson(join(conformance, "pass", "minimal-required-only.json"));
    expect(validateOpportunity({ ...doc, specVersion: "1.0.1" }).valid).toBe(false);
    expect(validateOpportunity({ ...doc, specVersion: "2.0.0" }).valid).toBe(false);
  });
});

describe("assertOpportunity", () => {
  it("narrows a valid opportunity", () => {
    const data: unknown = readJson(join(conformance, "pass", "grant.json"));
    assertOpportunity(data);
    // type is now Opportunity
    expect(data.fundingType).toBe("grant");
  });

  it("throws on an invalid opportunity", () => {
    expect(() => assertOpportunity({ fundingType: "grant" })).toThrow(/invalid opportunity/);
  });
});

describe("real example entries (@rfp-hub/standard)", () => {
  const examples = loadDir(join(standard, "schemas", "v1.0.0", "examples"));

  it("has a meaningful sample", () => {
    expect(examples.length).toBeGreaterThanOrEqual(20);
  });

  for (const { name, data } of examples) {
    it(`validates real example: ${name}`, () => {
      const { valid, errors } = validateOpportunity(data);
      if (!valid) console.error(name, humanizeErrors(errors));
      expect(valid).toBe(true);
    });
  }
});
