import { describe, expect, it } from "vitest";
import { humanizeErrors, validateOpportunity } from "../src/index.js";

const base = {
  specVersion: "1.0.0",
  id: "err",
  title: "T",
  description: "D",
  status: "open" as const,
  operatingOrganizations: [{ name: "Org", slug: "org" }],
  source: {},
};

/**
 * ajv's raw output for this schema's two conditional constructs is unreadable: a failed
 * `fundingDetails` sprays the errors of every `oneOf` branch, and every if/then failure is
 * reported twice. These messages are the validator's entire user interface, so they are held
 * to the same bar as the rules themselves.
 */
describe("humanizeErrors", () => {
  it("keeps only the tagged branch's errors and names the unknown field", () => {
    const doc = {
      ...base,
      fundingType: "grant",
      fundingDetails: { fundingType: "grant", recuring: true },
    };
    const { valid, errors } = validateOpportunity(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(1); // the raw oneOf spray this module exists to tame
    expect(humanizeErrors(errors, doc)).toEqual([
      "/fundingDetails grant details: unknown field 'recuring'",
    ]);
  });

  it("reports a tag mismatch as one line naming both tags", () => {
    const doc = {
      ...base,
      fundingType: "grant",
      fundingDetails: { fundingType: "hackathon", location: "Berlin", online: false },
    };
    const { valid, errors } = validateOpportunity(doc);
    expect(valid).toBe(false);
    expect(humanizeErrors(errors, doc)).toEqual([
      "fundingDetails.fundingType 'hackathon' does not match the opportunity's fundingType 'grant'",
    ]);
  });

  it("asks for the missing tag in one line instead of spraying every branch", () => {
    const doc = { ...base, fundingType: "grant", fundingDetails: {} };
    const { valid, errors } = validateOpportunity(doc);
    expect(valid).toBe(false);
    expect(humanizeErrors(errors, doc)).toEqual([
      "/fundingDetails must carry a fundingType tag naming its shape " +
        "(one of: grant, hackathon, bounty, accelerator, vc_fund, rfp)",
    ]);
  });

  it("drops the redundant if/then wrapper but keeps the real constraint", () => {
    const doc = {
      ...base,
      fundingType: "grant",
      fundingDetails: { fundingType: "grant" },
      deadlines: [{ deadlineType: "fixed", label: "application" }],
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
      fundingDetails: { fundingType: "grant" },
    };
    const lines = humanizeErrors(validateOpportunity(doc).errors, doc);
    expect(lines.some((l) => l.startsWith("/status") && l.includes("upcoming, open"))).toBe(true);
    expect(lines.some((l) => l.startsWith("/specVersion") && l.includes('"1.0.0"'))).toBe(true);
  });
});
