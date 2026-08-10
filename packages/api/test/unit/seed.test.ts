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

const mapped = Object.values(UPSTREAM_PROGRAMS).map((p) => mapProgram(p));

describe("gateForSeed", () => {
  it("accepts every record the mapper produces from the recorded upstream shapes", () => {
    const { accepted, rejected } = gateForSeed(mapped);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(mapped.length);
  });

  // The whole point of the gate: a bad record is named, not silently subtracted from a count.
  it("rejects a non-conforming record and reports its id and the rules it broke", () => {
    const good = mapProgram(grantProgram);
    const bad = { ...good, id: "fundingmap:broken", status: "Active" } as unknown as Opportunity;
    const { accepted, rejected } = gateForSeed([good, bad]);

    expect(accepted).toEqual([good]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe("fundingmap:broken");
    expect(rejected[0]?.errors.join(" ")).toContain("/status");
  });

  it("rejects a fundingDetails tag that disagrees with the top-level fundingType", () => {
    // Two type blocks are UNREPRESENTABLE since the single fundingDetails slot; the residual
    // failure mode is a details payload tagged as another type — the binding allOf rejects it.
    const good = mapProgram(grantProgram);
    const mismatched = {
      ...good,
      id: "fundingmap:mismatch",
      fundingDetails: { fundingType: "rfp", scope: "x" },
    } as unknown as Opportunity;
    const { rejected } = gateForSeed([mismatched]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.errors.join(" ")).toContain("does not match the opportunity's fundingType");
  });

  it("does not let advisory warnings reject a record", () => {
    const good = mapProgram(grantProgram);
    const warns = {
      ...good,
      eligibility: "Seed-stage teams only.",
      deadlines: [{ deadlineType: "rolling" as const, label: "whenever" }],
    } as Opportunity;
    expect(gateForSeed([warns]).rejected).toEqual([]);
  });

  it("hard-rejects the pre-re-cut eligibility OBJECT — eligibility is free text now", () => {
    const good = mapProgram(grantProgram);
    const objectEligibility = {
      ...good,
      id: "fundingmap:object-eligibility",
      eligibility: { projectStage: "seed" },
    } as unknown as Opportunity;
    const { rejected } = gateForSeed([objectEligibility]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.errors.join(" ")).toContain("/eligibility");
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
