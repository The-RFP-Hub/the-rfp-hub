/**
 * The seed's reproducibility contract: the frozen corpus, the offline `--from-file` path that
 * reads it, and the ordering guarantee that no row is written until the batch clears the floor.
 * No DB and no network — the corpus is read off disk and the writer is a spy.
 *
 * seed.test.ts covers the ingestion gate itself; this file covers HOW a run is fed and guarded.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { describe, expect, it, vi } from "vitest";
import { mapProgram } from "../../scripts/map-program.js";
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
  it("reads --from-file <path> and --from-file=<path>", () => {
    expect(parseSeedOptions(["node", "seed.ts", "--from-file", "corpus.json"], {})).toEqual({
      strict: false,
      fixturePath: "corpus.json",
    });
    expect(parseSeedOptions(["node", "seed.ts", "--from-file=corpus.json"], {})).toEqual({
      strict: false,
      fixturePath: "corpus.json",
    });
  });

  it("reads SEED_FIXTURE / SEED_STRICT from the environment", () => {
    expect(
      parseSeedOptions(["node", "seed.ts"], { SEED_FIXTURE: "corpus.json", SEED_STRICT: "1" }),
    ).toEqual({ strict: true, fixturePath: "corpus.json" });
  });

  it("lets the flag win over the env, and combines with --strict", () => {
    expect(
      parseSeedOptions(["node", "seed.ts", "--from-file", "flag.json", "--strict"], {
        SEED_FIXTURE: "env.json",
      }),
    ).toEqual({ strict: true, fixturePath: "flag.json" });
  });

  it("is live mode when nothing asks for a corpus", () => {
    expect(parseSeedOptions(["node", "seed.ts"], {})).toEqual({
      strict: false,
      fixturePath: undefined,
    });
  });

  // A run that meant to be offline must fail, never quietly fall through to the network.
  it("rejects --from-file with no path instead of falling back to the live source", () => {
    expect(() => parseSeedOptions(["node", "seed.ts", "--from-file"], {})).toThrow(/needs a path/);
    expect(() => parseSeedOptions(["node", "seed.ts", "--from-file="], {})).toThrow(/needs a path/);
    // the next flag is a flag, not a file named "--strict"
    expect(() => parseSeedOptions(["node", "seed.ts", "--from-file", "--strict"], {})).toThrow(
      /needs a path/,
    );
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
      const std = mapProgram(program, { sourceSystem: "fundingmap" });
      if (seen.has(std.id)) continue;
      seen.add(std.id);
      mapped.push(std);
    }

    const { accepted, rejected } = gateForSeed(mapped);
    expect(rejected).toEqual([]);
    expect(accepted.length).toBeGreaterThanOrEqual(MIN_VALID);
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
    Array.from({ length: n }, (_, i) =>
      mapProgram({ ...grantProgram, programId: String(i) }, { sourceSystem: "fundingmap" }),
    );

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
    const rejected = [{ id: "fundingmap:bad", errors: ["/status must be one of …"] }];
    await expect(loadValidated(ok(MIN_VALID), rejected, write, { strict: true })).rejects.toThrow(
      /fundingmap:bad/,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("honors a custom floor for smaller deployments", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(loadValidated(ok(3), [], write, { strict: true, min: 3 })).resolves.toBe(3);
    expect(write).toHaveBeenCalledTimes(3);
  });
});
