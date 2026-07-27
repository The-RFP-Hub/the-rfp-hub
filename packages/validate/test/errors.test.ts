import { describe, expect, it } from "vitest";
import { humanizeErrors, validateOpportunity } from "../src/index.js";

const base = {
  specVersion: "1.0.0",
  id: "err",
  title: "T",
  description: "D",
  status: "open" as const,
  sponsoringOrganizations: [{ name: "Org" }],
  source: {},
};

/**
 * ajv's raw output for this schema's two conditional constructs is unreadable: `not` yields
 * "must NOT be valid" and every if/then failure is reported twice. These messages are the
 * validator's entire user interface, so they are held to the same bar as the rules themselves.
 */
describe("humanizeErrors", () => {
  it("names the one-block-per-fundingType rule and the offending block", () => {
    const doc = { ...base, fundingType: "grant", grant: {}, rfp: { scope: "x" } };
    const { valid, errors } = validateOpportunity(doc);
    expect(valid).toBe(false);
    const lines = humanizeErrors(errors, doc);
    expect(lines.some((l) => l.includes("'rfp'") && l.includes("Only the 'grant' block"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("must NOT be valid"))).toBe(false);
  });

  it("still explains the rule without the instance, just without naming the block", () => {
    const doc = { ...base, fundingType: "grant", grant: {}, hackathon: {} };
    const lines = humanizeErrors(validateOpportunity(doc).errors);
    expect(lines.some((l) => l.includes("does not match fundingType"))).toBe(true);
    expect(lines.some((l) => l.includes("must NOT be valid"))).toBe(false);
  });

  it("drops the redundant if/then wrapper but keeps the real constraint", () => {
    const doc = {
      ...base,
      fundingType: "grant",
      grant: {},
      deadlines: [{ type: "fixed", label: "application" }],
    };
    const lines = humanizeErrors(validateOpportunity(doc).errors, doc);
    expect(lines).toContain("/deadlines/0 must have required property 'date'");
    expect(lines.some((l) => l.includes('must match "then" schema'))).toBe(false);
  });

  it("never returns an empty list while there are errors", () => {
    const doc = { ...base, fundingType: "grant" };
    const { errors } = validateOpportunity(doc);
    expect(errors.length).toBeGreaterThan(0);
    expect(humanizeErrors(errors, doc).length).toBeGreaterThan(0);
  });

  it("names the allowed values on enum and const failures", () => {
    const doc = {
      ...base,
      specVersion: "2.0.0",
      fundingType: "grant",
      status: "Active",
      grant: {},
    };
    const lines = humanizeErrors(validateOpportunity(doc).errors, doc);
    expect(lines.some((l) => l.startsWith("/status") && l.includes("upcoming, open"))).toBe(true);
    expect(lines.some((l) => l.startsWith("/specVersion") && l.includes('"1.0.0"'))).toBe(true);
  });
});
