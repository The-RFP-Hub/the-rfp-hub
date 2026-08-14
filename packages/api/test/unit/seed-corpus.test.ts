/**
 * The dataset's contract, and the loader's. `data/seed-corpus.json` is a repo artifact — reviewed,
 * versioned and served — so what it must hold true is asserted here rather than trusted to the
 * commit that last touched it. No DB and no network: the corpus is read off disk and the writer is
 * a spy.
 *
 * seed.test.ts covers the ingestion gate itself; this file covers WHAT is shipped and HOW a run is
 * fed and guarded.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type DetailsByFundingType, type Opportunity, SPEC_VERSION } from "@the-rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it, vi } from "vitest";
import {
  documentsFromCorpus,
  gateForSeed,
  loadValidated,
  parseSeedOptions,
  readCorpus,
} from "../../scripts/seed.js";

const CORPUS_PATH = fileURLToPath(new URL("../../data/seed-corpus.json", import.meta.url));

/**
 * The floor the SHIPPED corpus has to clear, deliberately under the 142 it carries. A margin means
 * a curator can retire a stale program without tripping a test; the distance to the seed's own
 * >=100 contract is what keeps the dataset from quietly eroding down to it.
 */
const CORPUS_FLOOR = 130;
const MIN_VALID = 100;

const DOCUMENTS = documentsFromCorpus(JSON.parse(readFileSync(CORPUS_PATH, "utf8")), CORPUS_PATH);

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
 * can reach an upstream is a seed whose output depends on someone else's uptime and on a credential
 * CI does not have — so the loader must contain no request at all, and no pointer at an upstream to
 * make one with. Bulk acquisition lives in tools/converter/, which is not on this path and which
 * nothing here imports.
 */
describe("the seed path cannot reach the network", () => {
  const SEED_PATH = fileURLToPath(new URL("../../scripts/seed.ts", import.meta.url));

  it("has no request and no upstream pointer in the loader", async () => {
    // strip comments so the prose explaining the decision cannot fail the check that enforces it
    const code = (await readFile(SEED_PATH, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code, "fetch(").not.toMatch(/\bfetch\s*\(/);
    expect(code, "an HTTP client").not.toMatch(/node:https?|undici|axios|node-fetch/);
    expect(code, "SOURCE_API_URL").not.toContain("SOURCE_API_URL");
    expect(code, "config.source*").not.toMatch(/config\.source/);
    expect(code, "the offline converter").not.toContain("tools/converter/map-program");
  });
});

describe("documentsFromCorpus", () => {
  it("accepts a bare array and an envelope carrying one", () => {
    const [one] = DOCUMENTS as [Opportunity];
    expect(documentsFromCorpus([one])).toEqual([one]);
    expect(documentsFromCorpus({ note: "curated", documents: [one] })).toEqual([one]);
  });

  it("refuses a corpus that would silently seed nothing", () => {
    expect(() => documentsFromCorpus([], "c.json")).toThrow(/no documents/);
    expect(() => documentsFromCorpus({ documents: {} }, "c.json")).toThrow(/expected an array/);
    expect(() => documentsFromCorpus(null, "c.json")).toThrow(/expected an array/);
  });
});

describe("the committed corpus", () => {
  it("is Standard documents at the version this package serves, not a foreign registry's rows", () => {
    expect(DOCUMENTS.length).toBeGreaterThanOrEqual(CORPUS_FLOOR);
    for (const d of DOCUMENTS) {
      expect(d.specVersion, d.id).toBe(SPEC_VERSION);
      expect(d.fundingType, d.id).toBeTruthy();
      expect(d, d.id).not.toHaveProperty("programId"); // an upstream row's shape, not ours
    }
  });

  // The point of committing it: the same file, gated, clears the floor every single run.
  it("validates end to end with nothing rejected", async () => {
    const documents = await readCorpus(CORPUS_PATH);
    const { accepted, rejected } = gateForSeed(documents);
    expect(rejected).toEqual([]);
    expect(accepted.length).toBeGreaterThanOrEqual(CORPUS_FLOOR);
    expect(accepted.length).toBeGreaterThanOrEqual(MIN_VALID);
  });

  /**
   * The ADVISORY baseline, itemised — every warning the shipped corpus raises, by code and by id.
   *
   * This replaces a test that ran the checks and then looked only at `.valid`. Advisory warnings
   * deliberately never change `.valid`, so that test asserted nothing beyond the schema test above
   * it while claiming the data "passes the advisory checks"; it was green against 16 warnings.
   *
   * Pinning the exact list rather than demanding zero, because these warnings are the registries
   * doing their job on data that is genuinely outside them, not defects to paper over:
   *
   * - `unregistered-program-model` — `programModel` is an OPEN list by design ("a publisher's own
   *   vocabulary is valid without a schema change"). "audit subsidy", "investment" and "venture"
   *   are what those programs are; flattening them to `grant` would lose the distinction the field
   *   exists to carry.
   * - `unregistered-deadline-label` — same, for labels. An RFP's eligible-activity window and a
   *   rolling solicitation's first-review date are real dates on real postings with no registered
   *   label to take them.
   * `amount-without-currency` used to be here too, for the one record that reached the corpus with
   * a figure and no unit (`fundingmap:1046`). It is gone — not silenced: the program denominates
   * its own budget in dollars in its own funding text, and its funder's round rules are dollar
   * -denominated, so the unit was researched rather than guessed and the record now carries it.
   *
   * A NEW warning fails this test, which is the point: the baseline can only move deliberately.
   */
  const ADVISORY_BASELINE: Record<string, string[]> = {
    "unregistered-program-model": [
      "fundingmap:996", // "audit subsidy"
      "fundingmap:1462", // "audit subsidy"
      "curated:mantle-ecofund", // "investment"
      "curated:arbitrum-gaming-ventures-agv", // "venture"
    ],
    "unregistered-deadline-label": [
      "fundingmap:1398", // "results announced"
      "curated:road-to-devcon-8-india-ecosystem-program", // "eligible activity window start"
      "curated:road-to-devcon-8-india-ecosystem-program", // "eligible activity window end"
      "curated:road-to-devcon-8-india-university-program", // "eligible activity window start"
      "curated:road-to-devcon-8-india-university-program", // "eligible activity window end"
      "curated:rfp-reboot-the-gitcoin-community-for-the-3-3-era", // "first review"
    ],
  };

  it("raises exactly the advisory warnings it is documented to raise — no more, no fewer", () => {
    const raised: Record<string, string[]> = {};
    let total = 0;
    for (const d of DOCUMENTS) {
      const { valid, warnings } = validateOpportunity(d, { checks: true });
      expect(valid, d.id).toBe(true); // advisory warnings never change this — see above
      for (const w of warnings) {
        const forCode = raised[w.code] ?? [];
        forCode.push(d.id);
        raised[w.code] = forCode;
      }
      total += warnings.length;
    }

    expect(Object.keys(raised).sort()).toEqual(Object.keys(ADVISORY_BASELINE).sort());
    for (const [code, ids] of Object.entries(ADVISORY_BASELINE)) {
      expect(raised[code], code).toEqual(ids);
    }
    // 10 warnings over 8 documents, as counted in the README.
    expect(total).toBe(Object.values(ADVISORY_BASELINE).flat().length);
    expect(total).toBe(10);
    expect(new Set(Object.values(ADVISORY_BASELINE).flat()).size).toBe(8);
  });

  it("gives every document a unique, namespaced id", () => {
    const ids = DOCUMENTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9-]+:.+/);
  });

  /**
   * PROVENANCE IS NOT DECORATION. The corpus holds two classes of record and the id namespace is
   * what tells them apart:
   *
   * - `fundingmap:` — converted from a snapshot of an upstream registry, so `source.originalId` is
   *   a real identifier IN THAT SOURCE SYSTEM, which is what the Standard says that field means.
   * - `curated:` — researched here from the funder's own pages. There is no source system and
   *   therefore no original id, and inventing one would both assert provenance that does not exist
   *   and reserve a key the actual registry may later issue to something else.
   *
   * These records used to ship in the upstream namespace with a synthetic numeric `originalId`.
   * They are indistinguishable from converted rows once that is true, which is why it is asserted
   * here rather than left to a curator to remember.
   */
  it("tells its two provenance classes apart, and neither claims the other's identifiers", () => {
    const namespaces = new Set(DOCUMENTS.map((d) => d.id.split(":")[0]));
    expect([...namespaces].sort()).toEqual(["curated", "fundingmap"]);

    for (const d of DOCUMENTS) {
      const originalId = d.source?.originalId;
      if (d.id.startsWith("curated:")) {
        expect(originalId ?? null, d.id).toBeNull();
        expect(d.id, d.id).toMatch(/^curated:[a-z0-9][a-z0-9-]*$/); // a name, not a foreign key
      } else {
        expect(originalId, d.id).toBeTruthy();
        expect(d.id, d.id).toBe(`fundingmap:${originalId}`);
      }
    }
  });

  /**
   * `postedAt` is "when the opportunity was first publicly announced AT THE SOURCE" — not when a
   * curator added it here, and not when anything else recorded the program. The Standard makes it
   * optional and says null means unknown, so the rule this file enforces is not "everyone has a
   * date": it is that a date, IF PRESENT, came from the source.
   *
   * Two passes established that. The first found published dates for the 57 `curated:` records
   * that shipped dateless, seven of them as archival bounds — "publicly visible by", the first
   * capture of the program's own page — where the funder published no announcement at all. The
   * second dealt with the converted class, whose `postedAt` was byte-identical to `createdAt` on
   * 65 of 66 records because both were inherited from the upstream snapshot's own row: those were
   * ingestion timestamps, several shared to the second by unrelated programs and most of them
   * later than the program's own `opensAt`. 26 were replaced with a date the funder or organiser
   * published; the other 39 carry no `postedAt` at all, because absence is what the Standard has
   * for unknown and prose cannot turn a row timestamp into an announcement.
   *
   * That is why the equality guard below now runs on EVERY document rather than on `curated:`
   * only — the class it used to be scoped around is the class that no longer carries the values
   * it was scoped around.
   */
  it("dates a document to its source or not at all, never to a Hub timestamp", () => {
    const now = Date.now();
    for (const d of DOCUMENTS) {
      if (d.postedAt === undefined || d.postedAt === null) continue; // unknown, per the Standard
      const postedAt = new Date(d.postedAt).getTime();
      expect(postedAt, d.id).toBeLessThanOrEqual(new Date(d.createdAt as string).getTime());
      expect(postedAt, d.id).toBeLessThanOrEqual(now); // nothing is announced in the future
      expect(d.postedAt, d.id).not.toBe(d.createdAt); // a Hub timestamp is not an announcement
    }
  });

  /**
   * The split itself, pinned so it cannot drift back in silence: no converted record may reuse the
   * snapshot's row timestamp again, and the honest count of what is actually dated is a number a
   * reviewer can check rather than a claim in prose.
   */
  it("carries a source date on 121 documents and says nothing on the rest", () => {
    const dated = DOCUMENTS.filter((d) => d.postedAt !== undefined && d.postedAt !== null);
    expect(dated).toHaveLength(121);

    const byClass = (prefix: string) => dated.filter((d) => d.id.startsWith(prefix)).length;
    expect(byClass("curated:")).toBe(94); // every researched record
    expect(byClass("fundingmap:")).toBe(27); // 26 re-researched here, plus fundingmap:1382
  });

  /**
   * Statuses are the field most likely to go stale and the one consumers filter on hardest, so the
   * corpus is required to carry BOTH — an all-open dataset would mean the curation pass never
   * closed anything, which is the failure mode that made this dataset necessary.
   */
  it("carries a live mix of statuses and funding types, not one flat block", () => {
    const statuses = new Set(DOCUMENTS.map((d) => d.status));
    expect(statuses.has("open")).toBe(true);
    expect(statuses.has("closed")).toBe(true);
    expect(new Set(DOCUMENTS.map((d) => d.fundingType)).size).toBeGreaterThanOrEqual(4);
  });

  it("names a real operating organization on every document", () => {
    for (const d of DOCUMENTS) {
      expect(d.operatingOrganizations.length, d.id).toBeGreaterThan(0);
      expect(d.operatingOrganizations[0]?.name, d.id).toBeTruthy();
    }
  });

  /**
   * `bountyKind` decides which compensation field a bounty is even ALLOWED to carry, so the split
   * is pinned here together with the invariant underneath it: exactly one of `reward` /
   * `rewardTiers`, never both and never neither, and never a bare scalar on a security program.
   * A curation pass cannot re-shape a third of the corpus without this failing.
   */
  it("classifies every bounty, and each carries exactly one compensation shape", () => {
    const bounties = DOCUMENTS.filter((d) => d.fundingType === "bounty").map(
      (d) => d.fundingDetails as DetailsByFundingType["bounty"],
    );

    expect(bounties).toHaveLength(63);
    const kinds = bounties.map((b) => b.bountyKind);
    expect(kinds.filter((k) => k === "security")).toHaveLength(62);
    expect(kinds.filter((k) => k === "task")).toHaveLength(1);

    for (const b of bounties) {
      const hasScalar = Object.hasOwn(b, "reward");
      const hasTable = Object.hasOwn(b, "rewardTiers");
      expect(hasScalar).toBe(!hasTable);
      // a security bounty is never priced by a bare number — a scalar there is a maximum, not a fee
      if (b.bountyKind === "security") expect(hasTable).toBe(true);
    }
  });

  it("publishes only https URLs, and never a placeholder host", () => {
    const text = readFileSync(CORPUS_PATH, "utf8");
    expect(text.match(/"http:\/\/[^"]*"/g) ?? []).toEqual([]);
    expect(text).not.toMatch(/example\.(com|org)/);
  });

  it("is committed as text a reviewer can diff", () => {
    const raw = readFileSync(CORPUS_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").length).toBeGreaterThan(100); // pretty-printed, not one long line
  });
});

describe("loadValidated: the floor is asserted before anything is written", () => {
  const ok = (n: number): Opportunity[] =>
    Array.from({ length: n }, (_, i) => ({ ...(DOCUMENTS[0] as Opportunity), id: `x:${i}` }));

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

  /**
   * A duplicate id fails the run WITHOUT `--strict` too: unlike a malformed record, which an
   * operator may reasonably want skipped from their own corpus, a repeated id means the file gives
   * two answers to one question and nothing here can pick between them.
   */
  it("writes nothing when two documents share an id, strict or not", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const batch = ok(MIN_VALID);
    const withTwin = [...batch, { ...(batch[0] as Opportunity) }];
    await expect(loadValidated(withTwin, [], write, { strict: false })).rejects.toThrow(
      /duplicate id\(s\) in the corpus: x:0 \(×2\)/,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("honors a custom floor for smaller deployments", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(loadValidated(ok(3), [], write, { strict: true, min: 3 })).resolves.toBe(3);
    expect(write).toHaveBeenCalledTimes(3);
  });
});
