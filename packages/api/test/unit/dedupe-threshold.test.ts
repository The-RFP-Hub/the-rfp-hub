/**
 * THE THRESHOLD'S EVIDENCE, asserted on every commit.
 *
 * Two examples are not evidence, and a number in a config file that nothing checks drifts away from
 * the corpus it was chosen against. So the fixture sweep runs here: twelve positive pairs (the same
 * programme, reworded the way a second publisher would write it) and twelve negative pairs (distinct
 * corpus records, which share the domain's whole vocabulary), scored with the deterministic
 * provider and compared to the configured operating point.
 *
 * WHAT FAILING THIS MEANS. Not "the test is stale" — it means the corpus has grown a pair the
 * threshold no longer separates, and the choice has to be made again rather than papered over.
 *
 * No database and no credential: the deterministic provider is a pure function, which is exactly
 * why it exists. This suite therefore runs in CI, which is the whole point (a dedupe test gated on
 * an API key is a dedupe test nobody runs).
 */
import { describe, expect, it } from "vitest";
import { derivePairs, loadCorpus, sweep } from "../../scripts/dedupe-threshold-report.js";
import { DEFAULT_SIMILARITY_THRESHOLD } from "../../src/config.js";

const THRESHOLD = DEFAULT_SIMILARITY_THRESHOLD.deterministic;
const pairs = derivePairs(loadCorpus());
const result = sweep(pairs, THRESHOLD);

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
   * A separating threshold is necessary but not sufficient: one that sits a thousandth above the
   * best negative separates this corpus and nothing else. The band is what says the choice will
   * survive the next twenty records.
   */
  it("keeps a usable margin between the two classes", () => {
    expect(result.worstPositive).toBeGreaterThan(result.bestNegative);
    expect(result.margin).toBeGreaterThan(0.15);
  });

  it("sits the operating point inside the band rather than on its edge", () => {
    expect(THRESHOLD).toBeGreaterThan(result.bestNegative + 0.05);
    expect(THRESHOLD).toBeLessThan(result.worstPositive - 0.05);
  });

  it("is deterministic — the same corpus scores identically on a second pass", () => {
    const again = sweep(derivePairs(loadCorpus()), THRESHOLD);
    expect(again.positives).toEqual(result.positives);
    expect(again.negatives).toEqual(result.negatives);
  });
});
