/**
 * Pure unit tests for the seed's two guarantees: the ingestion gate (nothing unvalidated reaches
 * the database) and the >=100 contract guard. No DB and no network — only the exported helpers.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { describe, expect, it, vi } from "vitest";
import { mapProgram } from "../../scripts/map-program.js";
import {
  assertNoRejections,
  assertSeedContract,
  gateForSeed,
  reportRejections,
} from "../../scripts/seed.js";
import { UPSTREAM_PROGRAMS, grantProgram } from "../fixtures/upstream-programs.js";

const BASE = "https://example.org/programs";
const mapped = Object.values(UPSTREAM_PROGRAMS).map((p) => mapProgram(p, { programUrlBase: BASE }));

describe("gateForSeed", () => {
  it("accepts every record the mapper produces from the recorded upstream shapes", () => {
    const { accepted, rejected } = gateForSeed(mapped);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(mapped.length);
  });

  // The whole point of the gate: a bad record is named, not silently subtracted from a count.
  it("rejects a non-conforming record and reports its id and the rules it broke", () => {
    const good = mapProgram(grantProgram, { programUrlBase: BASE });
    const bad = { ...good, id: "fundingmap:broken", status: "Active" } as unknown as Opportunity;
    const { accepted, rejected } = gateForSeed([good, bad]);

    expect(accepted).toEqual([good]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe("fundingmap:broken");
    expect(rejected[0]?.errors.join(" ")).toContain("/status");
  });

  it("names the one-block-per-fundingType rule when a record carries two blocks", () => {
    const good = mapProgram(grantProgram, { programUrlBase: BASE });
    const twoBlocks = { ...good, id: "fundingmap:two", rfp: { scope: "x" } } as Opportunity;
    const { rejected } = gateForSeed([twoBlocks]);
    expect(rejected[0]?.errors.join(" ")).toContain("does not match fundingType");
  });

  it("does not let advisory warnings reject a record", () => {
    const good = mapProgram(grantProgram, { programUrlBase: BASE });
    const warns = {
      ...good,
      eligibility: { projectStage: "seed" },
      deadlines: [{ type: "rolling" as const, label: "whenever" }],
    } as Opportunity;
    expect(gateForSeed([warns]).rejected).toEqual([]);
  });

  it("prints every rejection with its id", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportRejections([{ id: "x:1", errors: ["/status must be ..."] }]);
    const printed = spy.mock.calls.flat().join("\n");
    spy.mockRestore();
    expect(printed).toContain("x:1");
    expect(printed).toContain("/status must be ...");
  });
});

describe("assertNoRejections", () => {
  const rejected = [{ id: "x:1", errors: ["boom"] }];

  it("throws under --strict, naming the offending ids", () => {
    expect(() => assertNoRejections(rejected, true)).toThrow(/x:1/);
  });

  it("is a no-op without --strict, and with nothing rejected", () => {
    expect(() => assertNoRejections(rejected, false)).not.toThrow();
    expect(() => assertNoRejections([], true)).not.toThrow();
  });
});

describe("assertSeedContract", () => {
  it("throws below the default floor of 100", () => {
    expect(() => assertSeedContract(99)).toThrow();
    expect(() => assertSeedContract(0)).toThrow(/seed contract/);
  });

  it("passes at or above the floor", () => {
    expect(() => assertSeedContract(100)).not.toThrow();
    expect(() => assertSeedContract(120)).not.toThrow();
  });

  it("honors a custom min", () => {
    expect(() => assertSeedContract(5, 5)).not.toThrow();
    expect(() => assertSeedContract(4, 5)).toThrow();
  });
});
