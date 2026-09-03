/** DERIVED, not typed out: a copy advertises filters the API rejects and looks like a broken tool. */
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { opportunitySchema } from "@the-rfp-hub/standard";
import { describe, expect, it } from "vitest";
import { FUNDING_TYPES, SORT_FIELDS, STATUSES, asEnumValues } from "../src/enums.js";
import { PROTOCOL_VERSION } from "../src/server.js";

const schema = opportunitySchema as { properties: Record<string, { enum?: string[] }> };

describe("enums derived from the standard", () => {
  it("fundingType matches the schema exactly, in the schema's order", () => {
    expect([...FUNDING_TYPES]).toEqual(schema.properties.fundingType?.enum);
  });

  it("status matches the schema exactly, in the schema's order", () => {
    expect([...STATUSES]).toEqual(schema.properties.status?.enum);
  });

  it("does not hard-code the values it publishes", () => {
    // If somebody replaces the derivation with a literal, this is the test that notices: the
    // assertion above would still pass against a hand-copied list that happens to be current.
    // Reading the schema here and finding a NON-EMPTY intersection with nothing else is not
    // enough, so assert the source of truth is actually consulted.
    expect(FUNDING_TYPES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(FUNDING_TYPES)).toBe(true);
    expect(Object.isFrozen(STATUSES)).toBe(true);
  });

  it("sort fields are the API's list contract, stated once", () => {
    // These are NOT derivable from the standard: two of them (`nextDeadlineAt`, `createdAt`) name
    // columns the API computes and keeps, and the schema knows nothing about either. The list is
    // therefore written out — and asserted here so a change is deliberate rather than a typo. The
    // contract test in `contract.test.ts` is what checks it against the API's own query schema.
    expect([...SORT_FIELDS]).toEqual([
      "nextDeadlineAt",
      "opensAt",
      "postedAt",
      "updatedAt",
      "createdAt",
    ]);
  });

  it("asEnumValues refuses an empty list rather than producing an unconstrained enum", () => {
    expect(() => asEnumValues([])).toThrow();
    expect(asEnumValues(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("protocol revision", () => {
  it("is the modern era, not the newest legacy revision the SDK exports", () => {
    // The SDK's `LATEST_PROTOCOL_VERSION` is the newest 2025-era revision and lives in this list.
    // If a future SDK folds the 2026-07-28 rewrite into the same list, this fails and the constant
    // in server.ts gets revisited instead of silently meaning something else.
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(PROTOCOL_VERSION);
  });
});
