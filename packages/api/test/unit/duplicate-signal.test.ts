/**
 * THE DUPLICATE PREDICATE, in isolation.
 *
 * `duplicate-signal.ts` is a pure function of numbers precisely so this file can exist: no
 * database, no provider, no clock, so every branch — including the ones a database is bad at
 * producing on demand, like a counterpart with a null norm — is reachable by writing the number
 * down.
 *
 * The case this file exists FOR is the asymmetry between `decidePair` and `shouldPrune`. They look
 * like a function and its negation and they are not, and a reviewer who reads them as one will
 * "simplify" `shouldPrune` into `!decidePair` and delete every overlap-arm pair on the next
 * nightly backfill.
 */
import { describe, expect, it } from "vitest";
import {
  type DuplicateRuleConfig,
  RULES_VERSION,
  decidePair,
  overlap,
  shouldPrune,
} from "../../src/modules/services/dedupe/duplicate-signal.js";

const RULE: DuplicateRuleConfig = {
  similarityThreshold: 0.75,
  overlapEnabled: true,
  overlapThreshold: 0.85,
  overlapMinTokens: 20,
  overlapMinSimilarity: 0.35,
  suppliesNorm: true,
};

const side = (norm: number | null, tokenCount: number | null) => ({ norm, tokenCount });

describe("overlap", () => {
  it("is cosine corrected by the norm ratio", () => {
    // cos 0.5, the longer side twice the magnitude of the shorter: 0.5 × 2 = 1.0.
    expect(overlap({ similarity: 0.5, leftNorm: 1, rightNorm: 2 })).toBeCloseTo(1, 10);
    // Symmetric: which side is longer cannot change the answer.
    expect(overlap({ similarity: 0.5, leftNorm: 2, rightNorm: 1 })).toBeCloseTo(1, 10);
  });

  it("is null when either norm is unknown", () => {
    expect(overlap({ similarity: 0.9, leftNorm: null, rightNorm: 2 })).toBeNull();
    expect(overlap({ similarity: 0.9, leftNorm: 2, rightNorm: null })).toBeNull();
  });

  /**
   * A zero-norm vector has nothing in it. The ratio against it is not a large overlap, it is an
   * undefined one, and returning Infinity here would accept every pair touching an empty entry.
   */
  it("is null for a zero norm rather than infinite", () => {
    expect(overlap({ similarity: 0.9, leftNorm: 0, rightNorm: 2 })).toBeNull();
  });
});

describe("decidePair", () => {
  it("accepts on the lexical arm and names it", () => {
    const decision = decidePair(
      { similarity: 0.8, left: side(1, 100), right: side(1, 100) },
      RULE,
    );
    expect(decision.accepted).toBe(true);
    expect(decision.arm).toBe("lexical");
    expect(decision.signal?.lexical).toBe(0.8);
  });

  /**
   * ORDER IS PART OF THE ANSWER. A pair both arms would take is recorded as `lexical`: that arm is
   * the shipped, better-evidenced one, and reporting such a pair as an overlap detection would
   * inflate arm B's apparent contribution exactly where somebody is measuring it.
   */
  it("prefers the lexical arm when both would accept", () => {
    const decision = decidePair(
      { similarity: 0.9, left: side(1, 100), right: side(3, 100) },
      RULE,
    );
    expect(decision.arm).toBe("lexical");
  });

  it("accepts on the overlap arm when cosine alone would not", () => {
    // cos 0.5 (below 0.75), norms 1 and 2 ⇒ overlap 1.0, 60 tokens on the shorter side.
    const decision = decidePair(
      { similarity: 0.5, left: side(1, 60), right: side(2, 200) },
      RULE,
    );
    expect(decision.accepted).toBe(true);
    expect(decision.arm).toBe("overlap");
    expect(decision.signal).toEqual({
      arm: "overlap",
      lexical: 0.5,
      overlap: 1,
      minTokens: 60,
    });
  });

  /**
   * The stub guard. Same numbers as the case above except the shorter side is a 12-token stub —
   * exactly the shape of the attack — and the arm does not fire.
   */
  it("refuses the overlap arm below MIN_TOKENS", () => {
    const decision = decidePair(
      { similarity: 0.5, left: side(1, 12), right: side(2, 200) },
      RULE,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.signal).toBeNull();
  });

  it("refuses the overlap arm below the cosine floor", () => {
    const decision = decidePair(
      { similarity: 0.2, left: side(1, 60), right: side(9, 200) },
      RULE,
    );
    expect(decision.accepted).toBe(false);
  });

  /**
   * Overlap above 1 is NORMAL — a shorter side made of the longer side's highest-weight terms
   * measures 1.223 on an honest truncation of a real corpus entry. The threshold is a lower bound,
   * so nothing is clamped, and the recorded value is the measurement rather than a capped one.
   */
  it("accepts an overlap above 1 and records it unclamped", () => {
    const decision = decidePair(
      { similarity: 0.5, left: side(1, 60), right: side(3, 200) },
      RULE,
    );
    expect(decision.arm).toBe("overlap");
    expect(decision.signal?.overlap).toBe(1.5);
  });

  it("does not accept on the overlap arm when a norm is unknown", () => {
    const decision = decidePair(
      { similarity: 0.5, left: side(null, 60), right: side(2, 200) },
      RULE,
    );
    expect(decision.accepted).toBe(false);
  });

  it("is inert when the arm is switched off, or the provider supplies no norm", () => {
    const inputs = { similarity: 0.5, left: side(1, 60), right: side(2, 200) };
    expect(decidePair(inputs, { ...RULE, overlapEnabled: false }).accepted).toBe(false);
    expect(decidePair(inputs, { ...RULE, suppliesNorm: false }).accepted).toBe(false);
  });
});

describe("shouldPrune", () => {
  it("prunes a pair neither arm accepts any more", () => {
    expect(
      shouldPrune({ similarity: 0.2, left: side(1, 100), right: side(1, 100) }, RULE),
    ).toBe(true);
  });

  it("leaves a pair the overlap arm still accepts", () => {
    expect(
      shouldPrune({ similarity: 0.5, left: side(1, 60), right: side(2, 200) }, RULE),
    ).toBe(false);
  });

  /**
   * THE ASYMMETRY, as its own case. The identical inputs are REFUSED by `decidePair` and NOT
   * PRUNED by `shouldPrune`, because the two functions answer different questions: "is this
   * candidate a duplicate" versus "delete this row somebody's detector already wrote". An unknown
   * norm means "cannot be re-measured yet", and the service has always left an unmeasurable
   * counterpart alone rather than treating it as dissimilar.
   */
  it("does NOT prune when a norm is unknown, though decidePair refuses it", () => {
    const inputs = { similarity: 0.5, left: side(null, 60), right: side(2, 200) };
    expect(decidePair(inputs, RULE).accepted).toBe(false);
    expect(shouldPrune(inputs, RULE)).toBe(false);
  });

  it("does NOT prune when a token count is unknown", () => {
    const inputs = { similarity: 0.5, left: side(1, null), right: side(2, 200) };
    expect(shouldPrune(inputs, RULE)).toBe(false);
  });

  /**
   * With arm B off there is nothing unknown about the decision — it is purely lexical — so pruning
   * must behave exactly as it did before this arm existed. Gating the null guard on the arm being
   * live is what keeps `DEDUPE_OVERLAP_ENABLED=false` a true rollback rather than a state in which
   * stale pairs can never be cleaned up.
   */
  it("prunes normally on unknown norms when the overlap arm is off", () => {
    const inputs = { similarity: 0.2, left: side(null, null), right: side(null, null) };
    expect(shouldPrune(inputs, { ...RULE, overlapEnabled: false })).toBe(true);
    expect(shouldPrune(inputs, { ...RULE, suppliesNorm: false })).toBe(true);
  });
});

describe("RULES_VERSION", () => {
  /**
   * A positive integer that fits `smallint`. It is the identity of the rule, written on every pair,
   * and the backfill's resweep arm selects `rules_version IS DISTINCT FROM` it — so a NULL from
   * before versioning existed is selected, re-judged and re-stamped exactly once.
   */
  it("is a positive smallint", () => {
    expect(Number.isInteger(RULES_VERSION)).toBe(true);
    expect(RULES_VERSION).toBeGreaterThan(0);
    expect(RULES_VERSION).toBeLessThan(32768);
  });
});
