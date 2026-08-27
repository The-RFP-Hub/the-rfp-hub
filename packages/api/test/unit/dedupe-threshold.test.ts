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
  defaultRule,
  deriveMutationPositives,
  derivePairs,
  hardestNegatives,
  hardestOverlapNegatives,
  loadCorpus,
  sweep,
} from "../../scripts/dedupe-threshold-report.js";
import { DEFAULT_OVERLAP_THRESHOLD, DEFAULT_SIMILARITY_THRESHOLD } from "../../src/config.js";
import { overlap as overlapOf } from "../../src/modules/services/dedupe/duplicate-signal.js";
import {
  LexicalEmbeddingProvider,
  cosineSimilarity,
} from "../../src/modules/services/dedupe/embedding-provider.js";
import { embeddingText } from "../../src/modules/shared/embedding-text.js";

const THRESHOLD = DEFAULT_SIMILARITY_THRESHOLD.lexical;
const OVERLAP_MIN = DEFAULT_OVERLAP_THRESHOLD.lexical;
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
    // The overlap arm's inputs are part of the fixture now: an `overlap` or `minTokens` that moved
    // between two runs would mean the norm or the token count is not a pure function of the text.
    expect(again.hardestCorpusOverlaps).toEqual(result.hardestCorpusOverlaps);
    expect(again.stubAttack).toEqual(result.stubAttack);
    expect(again.conjunction).toEqual(result.conjunction);
  });
});

/**
 * THE OVERLAP ARM'S EVIDENCE.
 *
 * The same discipline as the lexical arm above and the same failure meaning: a red build here is
 * the corpus having grown a pair the operating point no longer separates, not a stale test.
 *
 * One caveat governs every positive-side number in this block. The positives are MUTATED SELVES, so
 * a subset of them has an overlap near 1 by construction; "full recall on M3" is not a discovery.
 * All the evidential weight is on the negative side — 12 720 real pairs, hardest 0.682 — and the
 * assertions are written so that side is what can fail.
 */
describe("the overlap arm, against the committed corpus", () => {
  const rung = (id: string) => {
    const found = result.mutations.find((m) => m.id === id);
    if (!found) throw new Error(`no mutation report for ${id}`);
    return found;
  };

  /**
   * The pair of rungs that motivate the arm existing at all: both are missed by cosine at the
   * configured threshold (asserted above, and kept), and both are recovered in full by the
   * combined rule with a wide overlap margin.
   */
  it("recovers M3 and M5 in full under the combined rule", () => {
    expect(rung("M3").recallCombined).toBe(rung("M3").count);
    expect(rung("M5").recallCombined).toBe(rung("M5").count);
    expect(rung("M3").worstOverlap).toBeGreaterThan(OVERLAP_MIN);
    expect(rung("M5").worstOverlap).toBeGreaterThan(OVERLAP_MIN);
  });

  it("catches every rung M0–M7 under the combined rule", () => {
    const missed = result.mutations.filter((m) => m.recallCombined < m.count);
    expect(missed.map((m) => `${m.id} ${m.recallCombined}/${m.count}`)).toEqual([]);
  });

  /**
   * M7 is M5's text mutation with `applicationUrl`, `website` and `operatingOrganizations` blanked
   * on the right-hand side. It is the ONLY rung that carries evidence about structural fields —
   * every other rung preserves them by construction — and what it says is that the decision does
   * not depend on them.
   */
  it("still catches M7, where the re-lister copied no structural field", () => {
    expect(rung("M7").recallCombined).toBe(rung("M7").count);
  });

  it("has zero false positives over every distinct corpus pair, COMBINED", () => {
    expect(
      result.corpusPairsAcceptedCombined,
      `corpus pairs accepted by the combined rule: ${JSON.stringify(
        result.hardestCorpusOverlaps.slice(0, 3),
      )}`,
    ).toBe(0);
  });

  it("keeps a usable overlap band between the two classes", () => {
    expect(result.worstPositiveOverlap).toBeGreaterThan(result.hardestNegativeOverlap);
    expect(result.overlapBand).toBeGreaterThan(0.15);
  });

  it("sits the overlap operating point inside its band rather than on an edge", () => {
    expect(OVERLAP_MIN).toBeGreaterThan(result.hardestNegativeOverlap + 0.05);
    expect(OVERLAP_MIN).toBeLessThan(result.worstPositiveOverlap - 0.05);
  });

  /**
   * THE STUB-ATTACK REGRESSION, and the number to read is `marginalWins`.
   *
   * `armAWins` is 160/160 at a median winning stub of 5 tokens: the attack works against the
   * detector that ALREADY SHIPPED, it is filed as its own issue, and this change neither creates
   * nor worsens it. What this change is accountable for is the exposure it ADDS, and that is
   * asserted at exactly zero — every target arm B reaches was already reachable through arm A.
   * `armBWins` is pinned as an inequality because the absolute figure is a property of this corpus
   * and will move as the corpus grows; the marginal figure is a property of the rule.
   */
  it("adds no new stub-attack exposure over the already-shipped lexical arm", () => {
    expect(result.stubAttack.targets).toBeGreaterThanOrEqual(100);
    expect(result.stubAttack.marginalWins).toBe(0);
    expect(result.stubAttack.armBWins).toBeLessThanOrEqual(3);
  });

  /**
   * The guard's justification, kept executable rather than left in a commit message: without the
   * 20-token floor the same attack wins on most of the corpus. A future contributor who lowers
   * `MIN_TOKENS` to recover recall on short entries will see exactly what it costs.
   */
  it("shows MIN_TOKENS is load-bearing, not decorative", () => {
    expect(result.stubAttack.armBWinsWithoutTokenGuard).toBeGreaterThanOrEqual(100);
    expect(result.stubAttack.armBWins).toBeLessThanOrEqual(3);
  });

  /**
   * THE REJECTED ALTERNATIVE, pinned so it cannot be re-proposed without new data. A structural
   * conjunction band `(url ∨ org) ∧ overlap ≥ C_low` needs `C_low` above the hardest corroborated
   * negative — which is the SAME pair and the SAME value as the global hardest — while every rung's
   * worst overlap is already far above that. The band catches nothing, and since a stub attacker
   * copies `applicationUrl` for free it would make §0.3's attack easier, not harder.
   */
  it("shows the structural conjunction band would catch nothing", () => {
    expect(result.conjunction.corroboratedPairs).toBeGreaterThan(0);
    expect(result.conjunction.hardestCorroboratedOverlap).toBe(result.conjunction.hardestOverlap);
    const worstRung = Math.min(...result.mutations.map((m) => m.worstOverlap));
    expect(worstRung).toBeGreaterThan(result.conjunction.hardestCorroboratedOverlap);
  });

  /**
   * The corpus's genuinely hard negatives, named: the Arbitrum DDA tracks, the Rocket Pool GMC
   * rounds, the Road to Devcon regional programmes, the SSV grant/bounty pair. A new funder family
   * that closes the band should surface here with a name attached.
   */
  it("keeps the named funder families below both arms", () => {
    const caught = result.structuralNegativeScores.filter(
      (pair) =>
        pair.similarity >= THRESHOLD ||
        (pair.minTokens >= result.rule.overlapMinTokens &&
          pair.similarity >= result.rule.overlapMinSimilarity &&
          pair.overlap >= OVERLAP_MIN),
    );
    expect(caught, `structural negatives caught: ${JSON.stringify(caught)}`).toEqual([]);
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
   * THE ACKNOWLEDGED LIMITS, recorded rather than hidden — and scoped honestly: at the CONFIGURED
   * threshold, chosen mid-band for false-positive headroom, a body truncated to 40% (M3) or
   * truncated AND compressed AND reordered (M5) is missed BY THE LEXICAL ARM ALONE. The same
   * featurizer recovers both at its zero-false-positive point (the report prints that column), so
   * "missed" is a property of the conservative operating point, not an absolute bound of lexical
   * methods.
   *
   * KEPT, and retitled, now that the overlap arm catches both rungs in full: this is what makes
   * arm B's contribution ATTRIBUTABLE. Delete it and nothing distinguishes "the second arm earns
   * its keep" from "the corpus got easier". A ladder that silently omitted the rungs one arm fails
   * would be a test that lies.
   */
  it("records M3 and M5 as missed by the lexical arm alone", () => {
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

  /**
   * The same falsification for the overlap arm: weights from one half, band measured on the other.
   * The out-of-sample band is narrower than the in-sample one (0.195 against 0.274) — as it should
   * be — and the floor is set below the measured value so honest degradation is not a red build
   * while a collapse is.
   */
  it("generalises the OVERLAP band to held-out documents — at least 0.15 on the unseen half", () => {
    const training = corpus.filter((_, index) => index % 2 === 1);
    const heldOut = corpus.filter((_, index) => index % 2 === 0);
    const provider = new LexicalEmbeddingProvider({ table: buildIdfTable(training) });
    const rule = defaultRule();

    const positives = ["M0", "M3", "M5", "M6", "M7"].flatMap((id) =>
      deriveMutationPositives(heldOut, id as "M0").map((pair) => {
        const left = provider.embedSyncDetailed(embeddingText(pair.left));
        const right = provider.embedSyncDetailed(embeddingText(pair.right));
        return (
          overlapOf({
            similarity: cosineSimilarity(left.vector, right.vector),
            leftNorm: left.norm,
            rightNorm: right.norm,
          }) ?? 0
        );
      }),
    );
    const worstPositive = Math.min(...positives);
    const hardestNegative = hardestOverlapNegatives(heldOut, provider, 1, rule)[0]?.overlap ?? 1;

    expect(positives.length).toBeGreaterThanOrEqual(8);
    expect(worstPositive).toBeGreaterThan(hardestNegative);
    expect(worstPositive - hardestNegative).toBeGreaterThanOrEqual(0.15);
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

describe("hostile-looking but ordinary vocabulary", () => {
  /**
   * `df["constructor"]` on a plain object answers `Object.prototype.constructor` — a function —
   * and the idf of one such token would turn NaN and poison every coordinate through
   * normalisation. The provider stores its table as a Map for exactly this reason; this pins it.
   */
  it("embeds prototype-chain property names to a finite, self-similar vector", () => {
    const provider = new LexicalEmbeddingProvider();
    const vector = provider.embedSync(
      "constructor prototype toString hasOwnProperty valueOf grants",
    );
    expect(vector).toHaveLength(1536);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 6);
  });
});
