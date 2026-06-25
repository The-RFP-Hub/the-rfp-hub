import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertOpportunity, humanizeErrors, validateOpportunity } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const loadDir = (d: string) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, data: readJson(join(d, f)) }));

describe("validateOpportunity", () => {
  for (const { name, data } of loadDir(join(here, "fixtures", "valid"))) {
    it(`accepts valid fixture: ${name}`, () => {
      expect(validateOpportunity(data).valid).toBe(true);
    });
  }

  for (const { name, data } of loadDir(join(here, "fixtures", "invalid"))) {
    it(`rejects invalid fixture: ${name}`, () => {
      const { valid, errors } = validateOpportunity(data);
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(humanizeErrors(errors).every((l) => typeof l === "string")).toBe(true);
    });
  }

  it("rejects an unsupported spec", () => {
    expect(() => validateOpportunity({}, { spec: "9.9.9" })).toThrow(/unsupported spec/);
  });
});

describe("assertOpportunity", () => {
  it("narrows a valid opportunity", () => {
    const data: unknown = readJson(join(here, "fixtures", "valid", "grant.json"));
    assertOpportunity(data);
    // type is now Opportunity
    expect(data.type).toBe("grant");
  });

  it("throws on an invalid opportunity", () => {
    expect(() => assertOpportunity({ type: "grant" })).toThrow(/invalid opportunity/);
  });
});

describe("real Karma examples (@rfp-hub/standard)", () => {
  const examplesDir = join(here, "..", "..", "standard", "schemas", "v1.0.0", "examples");
  const examples = loadDir(examplesDir);

  it("has a meaningful sample", () => {
    expect(examples.length).toBeGreaterThanOrEqual(20);
  });

  for (const { name, data } of examples) {
    it(`validates real example: ${name}`, () => {
      expect(validateOpportunity(data).valid).toBe(true);
    });
  }
});
