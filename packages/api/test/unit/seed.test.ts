/**
 * Pure unit tests for the seed's two guarantees: the ingestion gate (nothing unvalidated reaches
 * the database) and the >=100 contract guard. No DB and no network — only the exported helpers.
 *
 * The cases are built from documents in the committed corpus rather than from a hand-written
 * fixture. The corpus IS the input the gate exists to guard, and a second copy of a Standard
 * document kept next to it could only drift away from the real one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { describe, expect, it, vi } from "vitest";
import {
  assertNoRejections,
  assertSeedContract,
  documentsFromCorpus,
  gateForSeed,
  reportRejections,
  sourceSystemOf,
} from "../../scripts/seed.js";

const CORPUS_PATH = fileURLToPath(new URL("../../data/seed-corpus.json", import.meta.url));

const DOCUMENTS = documentsFromCorpus(JSON.parse(readFileSync(CORPUS_PATH, "utf8")), CORPUS_PATH);
/** One real document of each shape the corpus carries, for the gate's per-record cases. */
const SAMPLES: Opportunity[] = [...new Map(DOCUMENTS.map((d) => [d.fundingType, d])).values()];
const [sample] = SAMPLES as [Opportunity];

describe("gateForSeed", () => {
  it("accepts every document the committed corpus carries", () => {
    const { accepted, rejected } = gateForSeed(DOCUMENTS);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(DOCUMENTS.length);
  });

  it("accepts one document of every funding type the corpus uses", () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(4);
    expect(gateForSeed(SAMPLES).rejected).toEqual([]);
  });

  // The whole point of the gate: a bad record is named, not silently subtracted from a count.
  it("rejects a non-conforming record and reports its id and the rules it broke", () => {
    const bad = { ...sample, id: "fundingmap:broken", status: "Active" } as unknown as Opportunity;
    const { accepted, rejected } = gateForSeed([sample, bad]);

    expect(accepted).toEqual([sample]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe("fundingmap:broken");
    expect(rejected[0]?.errors.join(" ")).toContain("/status");
  });

  it("rejects a fundingDetails tag that disagrees with the top-level fundingType", () => {
    // Two type blocks are UNREPRESENTABLE since the single fundingDetails slot; the residual
    // failure mode is a details payload tagged as another type — the binding allOf rejects it.
    const mismatched = {
      ...sample,
      id: "fundingmap:mismatch",
      fundingType: "grant",
      fundingDetails: { fundingType: "rfp", scope: "x" },
    } as unknown as Opportunity;
    const { rejected } = gateForSeed([mismatched]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.errors.join(" ")).toContain("does not match the opportunity's fundingType");
  });

  it("does not let advisory warnings reject a record", () => {
    const warns = {
      ...sample,
      eligibility: "Seed-stage teams only.",
      deadlines: [{ deadlineType: "rolling" as const, label: "whenever" }],
    } as Opportunity;
    expect(gateForSeed([warns]).rejected).toEqual([]);
  });

  it("hard-rejects the pre-re-cut eligibility OBJECT — eligibility is free text now", () => {
    const objectEligibility = {
      ...sample,
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

/**
 * `source_system` pairs with `original_id` in a uniqueness constraint, so what fills it decides
 * whether a re-seed updates its own rows or inserts a second copy of everything.
 */
describe("sourceSystemOf", () => {
  it("reads the namespace off the document's own id", () => {
    expect(sourceSystemOf("fundingmap:1459")).toBe("fundingmap");
    expect(sourceSystemOf(DOCUMENTS[0]?.id)).toBe("fundingmap");
  });

  it("is null for an id that declares no namespace, rather than inventing one", () => {
    expect(sourceSystemOf("1459")).toBeNull();
    expect(sourceSystemOf("")).toBeNull();
    expect(sourceSystemOf(undefined)).toBeNull();
  });

  it("keeps the namespace, not the rest, when the id carries further colons", () => {
    expect(sourceSystemOf("fundingmap:a:b")).toBe("fundingmap");
  });
});
