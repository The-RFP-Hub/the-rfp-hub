/**
 * THE THRESHOLD'S EVIDENCE, asserted on every commit.
 *
 * Two examples are not evidence, and a number in a config file that nothing checks drifts away
 * from the corpus it was chosen against. So the sweep runs here: the mutation-ladder positives
 * (the same programme, re-entered six increasingly evasive ways), the stride negatives, and —
 * the part a sample can never be — EVERY distinct pair of the committed corpus, scored with the
 * lexical provider and compared to the configured operating point.
 *
 * WHAT FAILING THIS MEANS. Not "the test is stale" — it means the corpus has grown a pair the
 * threshold no longer separates, or the frozen weighting has drifted from the corpus it was built
 * on, and the choice has to be made again rather than papered over.
 *
 * No database and no credential: the lexical provider is a pure function, which is exactly why it
 * can be the production detector and the CI detector at once.
 */
import { describe, expect, it } from "vitest";
import { buildIdfTable } from "../../scripts/build-idf-table.js";
import {
  type CorpusDocument,
  deriveMutationPositives,
  derivePairs,
  hardestNegatives,
  loadCorpus,
  sweep,
} from "../../scripts/dedupe-threshold-report.js";
import { DEFAULT_SIMILARITY_THRESHOLD } from "../../src/config.js";
import {
  LexicalEmbeddingProvider,
  cosineSimilarity,
} from "../../src/modules/services/dedupe/embedding-provider.js";
import { embeddingText } from "../../src/modules/shared/embedding-text.js";

const THRESHOLD = DEFAULT_SIMILARITY_THRESHOLD.lexical;
const corpus = loadCorpus();
const result = sweep(corpus, THRESHOLD);

describe("dedupe threshold, against the committed corpus", () => {
  it("derives at least eight positive and eight negative fixture pairs", () => {
    expect(result.positives.length).toBeGreaterThanOrEqual(8);
    expect(result.negatives.length).toBeGreaterThanOrEqual(8);
  });

  it("puts every positive pair at or above the configured threshold", () => {
    const missed = result.positives.filter((p) => p.similarity < THRESHOLD);
    expect(missed, `positives below ${THRESHOLD}: ${JSON.stringify(missed)}`).toEqual([]);
  });

  it("puts every negative pair below the configured threshold", () => {
    const caught = result.negatives.filter((n) => n.similarity >= THRESHOLD);
    expect(caught, `negatives at or above ${THRESHOLD}: ${JSON.stringify(caught)}`).toEqual([]);
  });

  /**
   * The assertion the old stride sample could never make, and the one that would have caught the
   * unweighted bag scoring two unrelated bug bounties at 0.893: no pair of DISTINCT corpus
   * documents may reach the operating point. Zero, or the detector fires on real data.
   */
  it("has zero false positives over every distinct corpus pair", () => {
    expect(
      result.corpusPairsAtOrAboveThreshold,
      `corpus pairs at or above ${THRESHOLD}: ${JSON.stringify(
        result.hardestCorpusNegatives.filter((n) => n.similarity >= THRESHOLD),
      )}`,
    ).toBe(0);
  });

  /**
   * A separating threshold is necessary but not sufficient: one that sits a thousandth above the
   * hardest negative separates this corpus and nothing else. The floor is a real one now that the
   * negative side is the full pairwise scan — the unweighted bag's honest band was 0.018.
   */
  it("keeps a usable margin between the two classes", () => {
    expect(result.worstPositive).toBeGreaterThan(result.bestNegative);
    expect(result.margin).toBeGreaterThan(0.3);
  });

  it("sits the operating point inside the band rather than on its edge", () => {
    expect(THRESHOLD).toBeGreaterThan(result.bestNegative + 0.05);
    expect(THRESHOLD).toBeLessThan(result.worstPositive - 0.05);
  });

  it("is deterministic — the same corpus scores identically on a second pass", () => {
    const again = sweep(loadCorpus(), THRESHOLD);
    expect(again.positives).toEqual(result.positives);
    expect(again.negatives).toEqual(result.negatives);
    expect(again.hardestCorpusNegatives).toEqual(result.hardestCorpusNegatives);
    expect(again.mutations).toEqual(result.mutations);
  });
});

describe("the mutation ladder, at the configured threshold", () => {
  const recall = (id: string): number => {
    const rung = result.mutations.find((m) => m.id === id);
    if (!rung) throw new Error(`no mutation report for ${id}`);
    expect(rung.count).toBeGreaterThanOrEqual(8);
    return rung.recallAtThreshold;
  };

  it("catches the honest re-listing (M0), full recall", () => {
    expect(recall("M0")).toBe(result.mutations[0]?.count);
  });

  it("catches heavy synonym swaps (M1), full recall", () => {
    expect(recall("M1")).toBe(result.mutations.find((m) => m.id === "M1")?.count);
  });

  it("catches synonym swaps plus compression (M4), full recall", () => {
    // The rung the unweighted bag could not climb at any zero-false-positive point — the reason
    // the idf weighting exists.
    expect(recall("M4")).toBe(result.mutations.find((m) => m.id === "M4")?.count);
  });

  /**
   * THE ACKNOWLEDGED LIMITS, recorded rather than hidden. A body truncated to 40% of its length
   * (M3), or truncated AND compressed AND reordered (M5), shares too little lexical mass for any
   * bag-of-words method to recover; moving these rungs is the case for structural signals, which
   * need their own labelled data first. A ladder that silently omitted the rungs we fail would be
   * a test that lies.
   */
  it("records M3 and M5 as out of reach for a lexical method", () => {
    expect(recall("M3")).toBe(0);
    expect(recall("M5")).toBe(0);
  });
});

describe("the frozen idf table", () => {
  /**
   * Falsifies "the frozen table is overfit to the seed corpus": build the weights from half the
   * documents, evaluate the band on the other half. Degradation is expected and real; a band that
   * collapsed out of sample would mean the weighting memorised the corpus instead of describing
   * the domain.
   */
  it("generalises to held-out documents — band at least 0.20 on the unseen half", () => {
    const training = corpus.filter((_, index) => index % 2 === 1);
    const heldOut = corpus.filter((_, index) => index % 2 === 0);
    const provider = new LexicalEmbeddingProvider({ table: buildIdfTable(training) });

    const positives = deriveMutationPositives(heldOut, "M0").map((pair) =>
      cosineSimilarity(
        provider.embedSync(embeddingText(pair.left)),
        provider.embedSync(embeddingText(pair.right)),
      ),
    );
    const worstPositive = Math.min(...positives);
    const hardestNegative = hardestNegatives(heldOut, provider, 1)[0]?.similarity ?? 1;

    expect(positives.length).toBeGreaterThanOrEqual(8);
    expect(worstPositive - hardestNegative).toBeGreaterThanOrEqual(0.2);
  });
});

describe("the idf exponent", () => {
  /**
   * Exponent 0 IS the historical featurizer: idf^0 = 1 leaves `1 + log(tf)` and nothing else.
   * Reproducing the numbers the old provider was pinned at (worst positive 0.911, best stride
   * negative 0.571, to the same rounding) is the proof that this change is a weight function and
   * a data file — the hashing, the tokenizer, the dimensions and the draws are untouched.
   */
  it("at zero, reproduces the unweighted bag's historical numbers exactly", () => {
    const legacy = new LexicalEmbeddingProvider({ idfExponent: 0 });
    const score = (left: CorpusDocument, right: CorpusDocument): number =>
      Math.round(
        cosineSimilarity(
          legacy.embedSync(embeddingText(left)),
          legacy.embedSync(embeddingText(right)),
        ) * 1000,
      ) / 1000;

    const pairs = derivePairs(corpus);
    const worstPositive = Math.min(
      ...pairs.positive.map((p) => score(p.left as CorpusDocument, p.right as CorpusDocument)),
    );
    const bestNegative = Math.max(
      ...pairs.negative.map((p) => score(p.left as CorpusDocument, p.right as CorpusDocument)),
    );
    expect(worstPositive).toBe(0.911);
    expect(bestNegative).toBe(0.571);
  });
});
