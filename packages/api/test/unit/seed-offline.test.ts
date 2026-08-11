/**
 * The seed's reproducibility contract: the committed corpus, the one argument that names it, and
 * the ordering guarantee that no row is written until the batch clears the floor. No DB and no
 * network — the corpus is read off disk and the writer is a spy.
 *
 * seed.test.ts covers the ingestion gate itself; this file covers HOW a run is fed and guarded.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DetailsByFundingType, Opportunity } from "@the-rfp-hub/standard";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_SYSTEM, mapProgram } from "../../scripts/map-program.js";
import {
  gateForSeed,
  loadValidated,
  parseSeedOptions,
  programsFromCorpus,
  readCorpus,
} from "../../scripts/seed.js";
import { grantProgram } from "../fixtures/upstream-programs.js";

const CORPUS_PATH = fileURLToPath(new URL("../fixtures/seed-corpus.json", import.meta.url));
const MIN_VALID = 100;

describe("parseSeedOptions", () => {
  it("takes the corpus path as the positional argument", () => {
    expect(parseSeedOptions(["node", "seed.ts", "corpus.json"], {})).toEqual({
      corpusPath: "corpus.json",
      strict: false,
    });
  });

  it("reads --strict from the flag or SEED_STRICT, in any argument order", () => {
    expect(parseSeedOptions(["node", "seed.ts", "corpus.json", "--strict"], {})).toEqual({
      corpusPath: "corpus.json",
      strict: true,
    });
    expect(parseSeedOptions(["node", "seed.ts", "--strict", "corpus.json"], {})).toEqual({
      corpusPath: "corpus.json",
      strict: true,
    });
    expect(parseSeedOptions(["node", "seed.ts", "corpus.json"], { SEED_STRICT: "1" })).toEqual({
      corpusPath: "corpus.json",
      strict: true,
    });
  });

  // The corpus file is the loader's ONLY input, so a run without one is a usage error — there is
  // no upstream left to fall through to, and nothing to guess.
  it("refuses a run with no corpus file", () => {
    expect(() => parseSeedOptions(["node", "seed.ts"], {})).toThrow(/no corpus file/);
    expect(() => parseSeedOptions(["node", "seed.ts", "--strict"], {})).toThrow(/no corpus file/);
  });

  it("refuses more than one corpus file rather than silently seeding the first", () => {
    expect(() => parseSeedOptions(["node", "seed.ts", "a.json", "b.json"], {})).toThrow(
      /expected one corpus file/,
    );
  });
});

/**
 * The offline guarantee, asserted on the source itself rather than trusted to review. A seed that
 * can reach an upstream is a seed whose output depends on someone else's uptime and on a
 * credential CI does not have — so the loader and the pure mapper it calls must contain no request
 * at all, and no pointer at an upstream to make one with. Acquisition lives in
 * scripts/fetch-corpus.ts, which is not on this path.
 */
describe("the seed path cannot reach the network", () => {
  const SEED_PATH = fileURLToPath(new URL("../../scripts/seed.ts", import.meta.url));
  const MAPPER_PATH = fileURLToPath(new URL("../../scripts/map-program.ts", import.meta.url));

  it("has no request and no upstream pointer in the loader or the mapper", async () => {
    for (const path of [SEED_PATH, MAPPER_PATH]) {
      // strip comments so the prose explaining the decision cannot fail the check that enforces it
      const code = (await readFile(path, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${path}: fetch(`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${path}: an HTTP client`).not.toMatch(/node:https?|undici|axios|node-fetch/);
      expect(code, `${path}: SOURCE_API_URL`).not.toContain("SOURCE_API_URL");
      expect(code, `${path}: config.source*`).not.toMatch(/config\.source/);
    }
  });
});

describe("programsFromCorpus", () => {
  it("accepts a bare array and an envelope carrying one", () => {
    expect(programsFromCorpus([grantProgram])).toEqual([grantProgram]);
    expect(programsFromCorpus({ note: "frozen", programs: [grantProgram] })).toEqual([
      grantProgram,
    ]);
  });

  it("refuses a corpus that would silently seed nothing", () => {
    expect(() => programsFromCorpus([], "c.json")).toThrow(/no programs/);
    expect(() => programsFromCorpus({ programs: {} }, "c.json")).toThrow(/expected an array/);
    expect(() => programsFromCorpus(null, "c.json")).toThrow(/expected an array/);
  });
});

describe("the frozen corpus", () => {
  it("is raw upstream programs, not Standard objects", async () => {
    const programs = await readCorpus(CORPUS_PATH);
    expect(programs.length).toBeGreaterThanOrEqual(120);
    for (const p of programs.slice(0, 5)) {
      expect(p).toHaveProperty("programId");
      expect(p).not.toHaveProperty("specVersion"); // that is the mapper's job, not the fixture's
      expect(p).not.toHaveProperty("fundingType");
    }
  });

  // The point of freezing it: the same file, mapped and gated, clears the floor every single run.
  it("maps and validates to at least the seed floor, with nothing rejected", async () => {
    const programs = await readCorpus(CORPUS_PATH);
    const seen = new Set<string>();
    const mapped: Opportunity[] = [];
    for (const program of programs) {
      const std = mapProgram(program);
      if (seen.has(std.id)) continue;
      seen.add(std.id);
      mapped.push(std);
    }

    const { accepted, rejected } = gateForSeed(mapped);
    expect(rejected).toEqual([]);
    expect(accepted.length).toBeGreaterThanOrEqual(MIN_VALID);
  });

  /**
   * `bountyKind` is inferred, not published, and it decides which compensation field the record is
   * even ALLOWED to carry — so a change to the inference silently re-shapes 46 of the 140 records.
   * The split is pinned here, on the real corpus, along with the invariant underneath it: exactly
   * one of `reward` / `rewardTiers`, never both and never neither. A drift in either direction
   * fails loudly instead of shipping a corpus that still validates while saying something else.
   */
  it("classifies every corpus bounty, and each carries exactly one compensation shape", async () => {
    const programs = await readCorpus(CORPUS_PATH);
    const bounties = programs
      .map((p) => mapProgram(p))
      .filter((o) => o.fundingType === "bounty")
      .map((o) => o.fundingDetails as DetailsByFundingType["bounty"]);

    expect(bounties).toHaveLength(46);
    const kinds = bounties.map((b) => b.bountyKind);
    expect(kinds.filter((k) => k === "security")).toHaveLength(44);
    expect(kinds.filter((k) => k === "task")).toHaveLength(2);

    for (const b of bounties) {
      const hasScalar = Object.hasOwn(b, "reward");
      const hasTable = Object.hasOwn(b, "rewardTiers");
      expect(hasScalar).toBe(!hasTable);
      // a security bounty is never priced by a bare number, whatever the source published
      if (b.bountyKind === "security") expect(hasTable).toBe(true);
    }
  });

  it("carries the real-world variety the mapper has to survive", async () => {
    const programs = await readCorpus(CORPUS_PATH);
    const types = new Set(programs.map((p) => p.type));
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect(programs.some((p) => (p.metadata?.organizations ?? []).length > 0)).toBe(true);
  });

  it("is committed as text a reviewer can diff", async () => {
    const raw = await readFile(CORPUS_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").length).toBeGreaterThan(100); // pretty-printed, not one long line
  });
});

describe("loadValidated: the floor is asserted before anything is written", () => {
  const ok = (n: number): Opportunity[] =>
    Array.from({ length: n }, (_, i) => mapProgram({ ...grantProgram, programId: String(i) }));

  it("writes every accepted record once the floor is cleared", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const batch = ok(MIN_VALID);
    await expect(loadValidated(batch, [], write, { strict: true })).resolves.toBe(MIN_VALID);
    expect(write).toHaveBeenCalledTimes(MIN_VALID);
    expect(write).toHaveBeenCalledWith(batch[0]);
  });

  // The regression this exists for: a short run used to upsert everything it had, THEN fail the
  // contract — leaving a partial approved+listed dataset live behind a non-zero exit code.
  it("writes NOTHING when the batch is short of the floor", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(loadValidated(ok(MIN_VALID - 1), [], write, { strict: false })).rejects.toThrow(
      /seed contract/,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("writes nothing when --strict trips on a rejection either", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const rejected = [{ id: `${SOURCE_SYSTEM}:bad`, errors: ["/status must be one of …"] }];
    await expect(loadValidated(ok(MIN_VALID), rejected, write, { strict: true })).rejects.toThrow(
      new RegExp(`${SOURCE_SYSTEM}:bad`),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("honors a custom floor for smaller deployments", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(loadValidated(ok(3), [], write, { strict: true, min: 3 })).resolves.toBe(3);
    expect(write).toHaveBeenCalledTimes(3);
  });
});
