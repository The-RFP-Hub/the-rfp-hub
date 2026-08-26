/**
 * The duplicate predicate, as a pure function of numbers.
 *
 * No drizzle, no database, no clock, no config module — `test/unit/data-access-boundary.test.ts`
 * enforces the first of those and the rest are the same discipline. Everything that decides
 * whether two entries are the same programme lives here, so it can be exercised by the offline
 * threshold harness (`scripts/dedupe-threshold-report.ts`) and by the shipped service through the
 * SAME code path. A rule that the evidence and the runtime evaluate separately is two rules.
 *
 * THE RULE
 *
 *   suspected(a, b)  ⟺  cosine ≥ similarityThreshold                          … arm A "lexical"
 *                    ∨  ( overlap arm live
 *                       ∧ norm(a) ≠ null ∧ norm(b) ≠ null
 *                       ∧ min(tokens(a), tokens(b)) ≥ overlapMinTokens
 *                       ∧ cosine ≥ overlapMinSimilarity
 *                       ∧ overlap(a, b) ≥ overlapThreshold )                  … arm B "overlap"
 *
 * WHAT `overlap` IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.
 *
 *   overlap(a,b) = dot(a,b) / min(‖a‖², ‖b‖²) = cos(â,b̂) · max(‖a‖,‖b‖) / min(‖a‖,‖b‖)
 *
 * It is COSINE CORRECTED BY THE NORM RATIO. It *estimates* how much of the shorter entry's
 * weighted vocabulary the longer entry accounts for. It is **not** a containment proof and it is
 * **not** bounded by 1: under `1 + log(tf)` weighting and signed feature hashing a shorter side
 * made of the longer side's HIGHEST-weight terms scores above 1 (measured to 1.543 on a
 * cherry-picked stub, 1.223 on an honest 40 %-truncation of a real corpus entry). Values above 1
 * are normal and are NOT clamped; the threshold is a lower bound, which is exactly why that is
 * harmless. Nothing here or downstream may call this number a probability, a percentage or a
 * containment.
 *
 * WHY `overlapMinTokens` EXISTS, and why it is the only guard that works. An attacker who wants a
 * target's entry flagged as their duplicate builds a stub out of the target's rarest terms. With
 * no substance guard that attack wins 142 of 160 corpus documents on arm B. At 20 distinct tokens
 * on the SHORTER side it wins 3. A norm-ratio ceiling was measured and deleted: it changed
 * nothing at any setting once `overlapMinSimilarity` was applied, and it would have clipped honest
 * truncations. An `overlap` CEILING is not proposed either — padding a stub with filler evades it.
 *
 * THE HONEST CONTEXT FOR THAT NUMBER: the same attack against the ALREADY-SHIPPED lexical arm wins
 * 160/160 at a median stub of 5 tokens. Targets reachable through arm B but not already reachable
 * through arm A: 0. So the stub attack is a pre-existing property of the shipped TF-IDF detector,
 * arm B's marginal exposure on this corpus is zero, and the arm-A exposure is filed as its own
 * issue rather than pretended into existence by this change.
 *
 * STRUCTURAL SIGNALS ARE NOT IN THIS PREDICATE, deliberately. The corpus's hardest negatives ARE
 * the structurally identical siblings — same application URL, same operating organization, same
 * deadline day — so gating on structure moves the safe floor by 0.024 against a worst positive of
 * 0.598. Structural evidence is recorded as EXPLANATION at read time (`matchedOn`) and barred from
 * the decision. See `docs/data-model.md` for the measurements.
 */

/** The two scalars one side of a pair contributes, either of which may be unknown. */
export interface SignalSide {
  /** Pre-normalisation L2 norm of the stored vector, or null when the row predates the column. */
  norm: number | null;
  /** Distinct embedded tokens, or null for the same reason. */
  tokenCount: number | null;
}

export interface DuplicateSignalInputs {
  /** The lexical cosine, exactly as it is stored on the pair row. */
  similarity: number;
  left: SignalSide;
  right: SignalSide;
}

export interface DuplicateRuleConfig {
  /** Arm A. Unchanged semantics, unchanged default, unchanged meaning on the pair row. */
  similarityThreshold: number;
  /** Arm B's switch, from `DEDUPE_OVERLAP_ENABLED`. */
  overlapEnabled: boolean;
  overlapThreshold: number;
  overlapMinTokens: number;
  overlapMinSimilarity: number;
  /**
   * The provider's declared capability. Arm B cannot be evaluated without it, and a config that
   * enables the arm against a provider that supplies no norms must degrade to arm A only rather
   * than to a rule that can never fire and never prune.
   */
  suppliesNorm: boolean;
}

/** Which arm accepted a pair. Stored on the row so arm-B volume is filterable from day one. */
export type DuplicateArm = "lexical" | "overlap";

/**
 * The NUMERIC decision inputs, recorded on the pair row.
 *
 * These are the values the decision was actually made on, so they stay meaningful forever. There
 * is deliberately no `structural` sub-object here: a stored structural label would go stale the
 * moment either entry is edited, and it is not part of the decision anyway.
 */
export interface DuplicateSignalRecord {
  arm: DuplicateArm;
  /** The lexical cosine, rounded the way the `similarity` column is. */
  lexical: number;
  /** The overlap estimate, or null when it could not be computed. Never clamped. */
  overlap: number | null;
  /** `min(tokens(a), tokens(b))`, or null when either side is unknown. */
  minTokens: number | null;
}

export interface DuplicateDecision {
  accepted: boolean;
  /** The arm that accepted, or null when nothing did. */
  arm: DuplicateArm | null;
  signal: DuplicateSignalRecord | null;
}

/**
 * The identity of the rule that produced a pair row.
 *
 * BUMP THIS whenever the predicate or any default threshold changes. `opportunity_duplicates.
 * rules_version` records it, and the `embedding-backfill` job's resweep arm re-evaluates and
 * retires every pair stamped with anything else. That is what makes `DEDUPE_OVERLAP_ENABLED=false`
 * a real rollback instead of a switch that strands the rows it already wrote — and it fixes the
 * identically-shaped pre-existing bug where changing `DEDUPE_SIMILARITY_THRESHOLD` stranded pairs
 * the same way. A NULL `rules_version` is every pair written before versioning existed; it is
 * "distinct from" the current version, so those are resweept once and re-stamped.
 */
export const RULES_VERSION = 1;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Cosine corrected by the norm ratio — see the header for what this does and does not mean.
 *
 * `null` when either norm is unknown or zero. Zero is a vector with nothing in it, and a ratio
 * against it is not a large overlap, it is an undefined one.
 */
export function overlap(inputs: {
  similarity: number;
  leftNorm: number | null;
  rightNorm: number | null;
}): number | null {
  const { similarity, leftNorm, rightNorm } = inputs;
  if (leftNorm === null || rightNorm === null) return null;
  if (!Number.isFinite(leftNorm) || !Number.isFinite(rightNorm)) return null;
  const low = Math.min(leftNorm, rightNorm);
  const high = Math.max(leftNorm, rightNorm);
  if (low <= 0) return null;
  return (similarity * high) / low;
}

/** `min(tokens)` when both sides are known, else null. */
function minTokens(left: SignalSide, right: SignalSide): number | null {
  if (left.tokenCount === null || right.tokenCount === null) return null;
  return Math.min(left.tokenCount, right.tokenCount);
}

/** Whether arm B exists in this configuration at all. */
function overlapArmLive(config: DuplicateRuleConfig): boolean {
  return config.overlapEnabled && config.suppliesNorm;
}

/**
 * Accept or reject one candidate pair.
 *
 * ORDER IS PART OF THE ANSWER: arm A is tried first, so a pair that both arms would accept is
 * recorded as `lexical`. The lexical arm is the shipped, better-evidenced one, and a pair it
 * catches should not be reported as an overlap detection just because the overlap number is also
 * over its threshold.
 */
export function decidePair(
  inputs: DuplicateSignalInputs,
  config: DuplicateRuleConfig,
): DuplicateDecision {
  const { similarity, left, right } = inputs;
  const value = overlap({ similarity, leftNorm: left.norm, rightNorm: right.norm });
  const tokens = minTokens(left, right);

  if (similarity >= config.similarityThreshold) {
    return {
      accepted: true,
      arm: "lexical",
      signal: {
        arm: "lexical",
        lexical: round3(similarity),
        overlap: nullableRound(value),
        minTokens: tokens,
      },
    };
  }

  if (
    overlapArmLive(config) &&
    value !== null &&
    tokens !== null &&
    tokens >= config.overlapMinTokens &&
    similarity >= config.overlapMinSimilarity &&
    value >= config.overlapThreshold
  ) {
    return {
      accepted: true,
      arm: "overlap",
      signal: {
        arm: "overlap",
        lexical: round3(similarity),
        overlap: round3(value),
        minTokens: tokens,
      },
    };
  }

  return { accepted: false, arm: null, signal: null };
}

/**
 * Whether an EXISTING suspected pair should be deleted. **Deliberately not `!decidePair(...)`.**
 *
 * The two questions are different and the difference is the unknown case. `decidePair` answers
 * "accept this candidate", where an unknown norm means "arm B cannot vouch for it" and the honest
 * answer is no. `shouldPrune` answers "delete this row somebody's detector already wrote", where
 * an unknown norm means "this counterpart cannot be re-measured yet" and the honest answer is
 * ALSO no — matching the rule the service has always had, that a counterpart with no comparable
 * vector is left alone rather than treated as dissimilar. Inverting `decidePair` here would
 * delete every arm-B pair on the first nightly backfill, and the pairs would come straight back
 * on the next detection pass: an oscillation that also re-notifies both owners each time round.
 *
 * The null guard is gated on arm B actually being live. With the arm off — the switch, or a
 * provider that supplies no norm — the decision is purely lexical and nothing about it is unknown,
 * so pruning must behave exactly as it did before this change existed.
 */
export function shouldPrune(inputs: DuplicateSignalInputs, config: DuplicateRuleConfig): boolean {
  if (overlapArmLive(config)) {
    const { left, right } = inputs;
    if (left.norm === null || right.norm === null) return false;
    if (left.tokenCount === null || right.tokenCount === null) return false;
  }
  return !decidePair(inputs, config).accepted;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round3(value);
}
