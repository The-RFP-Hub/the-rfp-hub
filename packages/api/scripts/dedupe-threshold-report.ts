/**
 * Where the duplicate threshold comes from — evidence, not two hand-picked examples.
 *
 *   pnpm --filter @the-rfp-hub/api dedupe:threshold
 *
 * A threshold is a property of an EMBEDDING SPACE, not a universal constant: the same cosine means
 * different things to a learned 1 536-dimension model and to a hashed token bag. So this sweeps
 * pairs derived from the committed corpus and reports the numbers that actually decide the
 * operating point — the WORST positive, the HARDEST negative, and the margin between them.
 *
 * HOW THE PAIRS ARE MADE, and why this is honest rather than circular:
 *
 *   POSITIVES are the realistic duplicate: the same programme, republished by somebody else in
 *   their own words. Six mutation classes (`MUTATIONS`) model six ways that happens, from the
 *   honest re-listing (synonyms, a few words dropped) to the evasive one (heavy synonyms,
 *   compression, truncation, reordering — everything at once). Each is DETERMINISTIC: fixed
 *   substitution tables and fixed strides, no RNG, so a rerun of this script and the CI assertion
 *   in `test/unit/dedupe-threshold.test.ts` are looking at the same pairs.
 *
 *   NEGATIVES are distinct corpus records — and not a hand-picked sample of them. The stride pairs
 *   this report started with turned out to understate the hardest case badly (they missed a pair
 *   of unrelated bug bounties the shipped detector scored at 0.893), so the sweep now scores EVERY
 *   pair of distinct corpus documents and takes the hardest as the number that matters. Two
 *   documents with nothing in common are separated by any threshold; the hardest pair in the
 *   corpus is the one the threshold is actually for.
 *
 * The report states TWO operating points: the configured threshold, and the zero-false-positive
 * point (just above the hardest corpus negative). Recall quoted at a threshold that also fires on
 * real non-duplicates is not recall, it is noise with good numbers.
 *
 * ── WHAT `overlap` IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────────
 *
 *   overlap(a,b) = dot(a,b) / min(‖a‖², ‖b‖²) = cos(â,b̂) · max(‖a‖,‖b‖) / min(‖a‖,‖b‖)
 *
 * It is COSINE CORRECTED BY THE NORM RATIO. It *estimates* how much of the shorter entry's
 * weighted vocabulary the longer entry accounts for. It is **not** a containment proof and it is
 * **not** bounded by 1: under `1 + log(tf)` weighting and signed feature hashing, a shorter side
 * made of the longer side's HIGHEST-weight terms scores above 1 — measured to 1.543 on a
 * cherry-picked stub and 1.223 on an honest 40 % truncation of a real corpus entry. Values above 1
 * are normal and are NOT clamped; the threshold is a lower bound, which is exactly why that is
 * harmless. Nothing in this report, the code or the docs may call this number a probability, a
 * percentage or a containment.
 *
 * ── THE STUB ATTACK, AND THE PRE-EXISTING EXPOSURE IT REVEALS ───────────────────────────────────
 *
 * `deriveStubAttacks` is not a curiosity: it is the adversarial half of the evidence, kept live so
 * it cannot silently rot. An attacker who wants somebody's entry flagged as *their* duplicate
 * builds a stub from the target's rarest terms. Three numbers matter and the report prints all
 * three:
 *
 *   - **arm A wins 160/160** at a median stub of 5 tokens. THIS IS A PROPERTY OF THE DETECTOR THAT
 *     ALREADY SHIPPED, not of the overlap arm, and it is filed as its own issue. Read the arm-B
 *     number below against this one, or arm B's small figure will be mistaken for the system's
 *     exposure.
 *   - **arm B wins 3/160** at `MIN_TOKENS = 20`. Without that guard it is 142/160, which is what
 *     makes the guard the only one worth having (a norm-ratio ceiling changed nothing at any
 *     setting; an `overlap` ceiling is evaded by padding the stub with filler).
 *   - **arm-B-only marginal exposure: 0/160** — every target reachable through arm B is already
 *     reachable through arm A. That is the number this change is accountable for, and it is the
 *     one the CI regression pins.
 *
 * ── THE CIRCULARITY IN THE POSITIVE SIDE, STATED PLAINLY ────────────────────────────────────────
 *
 * M0–M6 mutate TEXT ONLY. A mutated self keeps every structural field of its source, so it
 * trivially satisfies every structural signal — same application URL, same operating org, same
 * deadline. **The positive side therefore carries NO evidence about structural signals.** All the
 * evidence about them is on the negative side, where the pairs are real, and it says they cannot
 * be the gate: the corpus's hardest negatives ARE the structurally identical siblings, so
 * corroboration moves the safe floor by 0.024 against a worst positive of 0.598. M7 is the only
 * rung that speaks to the positive side, and what it says is that the decision does not depend on
 * structural fields at all: blank them and every pair still lands.
 *
 * The same caution applies to overlap itself. A mutated self of a long document is ≈1 by
 * construction for a subset of the rungs; "full recall on M3" is not a discovery. The number that
 * decides anything is the hardest of 12 720 REAL negatives.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_OVERLAP_THRESHOLD,
  DEFAULT_SIMILARITY_THRESHOLD,
  type EmbeddingProvider,
} from "../src/config.js";
import {
  type DuplicateRuleConfig,
  decidePair,
  overlap as overlapOf,
} from "../src/modules/services/dedupe/duplicate-signal.js";
import {
  LexicalEmbeddingProvider,
  cosineSimilarity,
  tokenize,
} from "../src/modules/services/dedupe/embedding-provider.js";
import committedIdfTable from "../src/modules/services/dedupe/idf-table.json";
import { type EmbeddableOpportunity, embeddingText } from "../src/modules/shared/embedding-text.js";

/** The corpus this repository ships, and the only input this script reads. */
const CORPUS_PATH = fileURLToPath(new URL("../data/seed-corpus.json", import.meta.url));

/**
 * Near-synonyms a second publisher plausibly reaches for.
 *
 * Small and domain-specific on purpose: a large substitution table would be measuring the table
 * rather than the space. `SUBSTITUTIONS_HEAVY` below is the deliberately larger one, used by the
 * evasion classes — there the table IS the threat being modelled.
 */
const SUBSTITUTIONS: [RegExp, string][] = [
  [/\bgrants?\b/gi, "funding"],
  [/\bprogramme?\b/gi, "initiative"],
  [/\bround\b/gi, "cohort"],
  [/\bfunding\b/gi, "support"],
  [/\bprojects?\b/gi, "teams"],
  [/\bapplications?\b/gi, "submissions"],
  [/\bbuilders?\b/gi, "developers"],
  [/\becosystems?\b/gi, "network"],
];

/**
 * The evasive re-lister's vocabulary: every domain word they would think to swap.
 *
 * Order matters and is fixed — earlier rules feed later ones exactly as a chain of edits would.
 */
const SUBSTITUTIONS_HEAVY: [RegExp, string][] = [
  ...SUBSTITUTIONS,
  [/\bdevelopers?\b/gi, "engineers"],
  [/\bcommunity\b/gi, "collective"],
  [/\bopen[- ]source\b/gi, "public-code"],
  [/\bsecurity\b/gi, "safety"],
  [/\brewards?\b/gi, "payouts"],
  [/\bbount(?:y|ies)\b/gi, "reward-pool"],
  [/\bmilestones?\b/gi, "checkpoints"],
  [/\bproposals?\b/gi, "pitches"],
  [/\bresearch\b/gi, "investigation"],
  [/\binfrastructure\b/gi, "tooling"],
  [/\bprotocols?\b/gi, "systems"],
  [/\bcontracts?\b/gi, "agreements"],
  [/\bdeadline\b/gi, "cutoff"],
  [/\beligible\b/gi, "qualifying"],
];

/**
 * Every sixth word dropped — a rewrite that says the same thing more briefly. The evasion classes
 * drop every third: a rewrite that is trying not to look like its source.
 */
const DROP_STRIDE = 6;

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const substitute = (text: string, table: [RegExp, string][]): string => {
  let out = text;
  for (const [pattern, replacement] of table) out = out.replace(pattern, replacement);
  return out;
};

const dropEvery = (text: string, stride: number): string =>
  text
    .split(/\s+/)
    .filter((_, index) => index % stride !== 0)
    .join(" ");

/** Keep the leading fraction of the words — the stub re-post that quotes the opening and stops. */
const truncateTo = (text: string, fraction: number): string => {
  const all = text.split(/\s+/).filter(Boolean);
  return all.slice(0, Math.max(1, Math.floor(all.length * fraction))).join(" ");
};

/** Reverse each sliding triple of words — order scrambled, vocabulary untouched. */
const reverseTriples = (text: string): string => {
  const all = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 3) out.push(...all.slice(i, i + 3).reverse());
  return out.join(" ");
};

function paraphrase(text: string): string {
  return dropEvery(substitute(text, SUBSTITUTIONS), DROP_STRIDE);
}

/** M5's operator, named so M7 can reuse it verbatim rather than restate it and drift. */
const MUTATIONS_M5_APPLY = (t: string): string =>
  reverseTriples(truncateTo(dropEvery(substitute(t, SUBSTITUTIONS_HEAVY), 3), 0.5));

export type MutationId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";

/**
 * The six ways one programme gets entered twice, each as a pure deterministic text operator.
 *
 * M0 is the honest re-listing this report always measured. M1–M5 are the evasion ladder: each rung
 * removes more of the lexical overlap a bag-of-words detector depends on, and the report says
 * plainly which rungs the configured space can and cannot climb.
 */
export const MUTATIONS: Record<MutationId, { label: string; apply: (text: string) => string }> = {
  M0: { label: "paraphrase (synonyms + drop 1-in-6)", apply: paraphrase },
  M1: {
    label: "heavy synonyms, nothing dropped",
    apply: (t) => substitute(t, SUBSTITUTIONS_HEAVY),
  },
  M2: { label: "word order scrambled in triples", apply: reverseTriples },
  M3: { label: "truncated to the leading 40%", apply: (t) => truncateTo(t, 0.4) },
  M4: {
    label: "heavy synonyms + drop 1-in-3",
    apply: (t) => dropEvery(substitute(t, SUBSTITUTIONS_HEAVY), 3),
  },
  M5: {
    label: "synonyms + drop + truncate 50% + reorder",
    apply: MUTATIONS_M5_APPLY,
  },
  // The hardest rung the overlap arm is expected to climb: a quarter of the body, already
  // synonym-swapped and compressed. It is also the rung that comes closest to `MIN_TOKENS`, which
  // is what makes the guard's cost visible rather than assumed.
  M6: {
    label: "heavy synonyms + drop 1-in-3 + truncate to 25%",
    apply: (t) => truncateTo(dropEvery(substitute(t, SUBSTITUTIONS_HEAVY), 3), 0.25),
  },
  // M5's text mutation AND the structural fields blanked on the right side. THE ONLY RUNG THAT
  // CARRIES EVIDENCE ABOUT STRUCTURAL SIGNALS: every other rung preserves them by construction, so
  // a claim that the decision does not depend on them is untestable without this one. Applied by
  // `deriveMutationPositives`, which blanks the fields for this id.
  M7: {
    label: "M5's text mutation, structural fields blanked",
    apply: MUTATIONS_M5_APPLY,
  },
};

export interface CorpusDocument extends EmbeddableOpportunity {
  id: string;
  /** Read ONLY for the structural tables. Never part of the embedded text or the decision. */
  applicationUrl?: string | null;
  operatingOrganizations?: { name?: string | null; slug?: string | null }[] | null;
  deadlines?: { date?: string | null; closesAt?: string | null }[] | null;
  fundingInfo?: { currency?: string | null; budget?: number | null } | null;
}

export interface DerivedPair {
  label: string;
  left: EmbeddableOpportunity;
  right: EmbeddableOpportunity;
}

export interface DerivedPairs {
  positive: DerivedPair[];
  negative: DerivedPair[];
}

// The RICHER of the two bodies, not `summary ?? description`: most corpus records carry a short
// one-line summary and a long description, so preferring the summary would have measured the
// detector against a sentence and called it evidence.
const bodyOf = (doc: CorpusDocument): string => {
  const summary = doc.summary ?? "";
  const description = doc.description ?? "";
  return summary.length >= description.length ? summary : description;
};

/** The records with enough text to mutate meaningfully — the same floor the report always used. */
const usableOf = (documents: CorpusDocument[]): CorpusDocument[] =>
  documents.filter((doc) => words(bodyOf(doc)) >= 60);

/**
 * Positive pairs for ONE mutation class: each usable record against its mutated self.
 *
 * BOTH sides are normalised onto the same body. `embeddingText` prefers `summary` and falls back
 * to a truncated `description`, so pairing a record's one-line summary against a mutation of its
 * long description would be comparing a sentence to an essay and reporting the length difference
 * as dissimilarity.
 */
export function deriveMutationPositives(
  documents: CorpusDocument[],
  mutation: MutationId,
  count = 12,
): DerivedPair[] {
  const { apply } = MUTATIONS[mutation];
  const positive: DerivedPair[] = [];
  for (const doc of usableOf(documents).slice(0, count)) {
    const body = bodyOf(doc);
    positive.push({
      label: `${doc.id} ↔ ${mutation}`,
      left: { ...doc, summary: body, description: body },
      right: {
        ...doc,
        // The site's furniture on the end, which is how a republished title normally reads.
        title: `${apply(doc.title ?? "")} | ${doc.operatingOrganizations?.[0]?.name ?? "Directory"}`,
        summary: apply(body),
        description: apply(body),
        // M7 ONLY. The re-lister who does not copy the source's links or attribution — the case
        // every other rung silently assumes away.
        ...(mutation === "M7"
          ? { applicationUrl: undefined, website: undefined, operatingOrganizations: [] }
          : {}),
      },
    });
  }
  return positive;
}

/**
 * The fixture pairs, from the corpus, deterministically: M0 positives and the fixed-stride
 * negatives this report has always derived. The stride negatives stay in the sweep for continuity,
 * but the number that decides anything is `hardestNegatives` below.
 */
export function derivePairs(documents: CorpusDocument[], count = 12): DerivedPairs {
  const usable = usableOf(documents);
  const positive = deriveMutationPositives(documents, "M0", count);

  // A fixed stride rather than adjacent records: the corpus is grouped by source, so neighbours are
  // unusually alike and pairing them would make the negatives easier than they are in practice.
  const stride = 7;
  const negative: DerivedPair[] = [];
  for (let i = 0; i < count && i < usable.length; i++) {
    const left = usable[i];
    const right = usable[(i + stride) % usable.length];
    if (!left || !right || left.id === right.id) continue;
    negative.push({ label: `${left.id} ↔ ${right.id}`, left, right });
  }

  return { positive, negative };
}

export interface ScoredPair {
  label: string;
  similarity: number;
  /** Cosine corrected by the norm ratio. NOT a containment, NOT bounded by 1 — see the header. */
  overlap: number;
  /** Distinct embedded tokens on the SHORTER side: the substance guard's input. */
  minTokens: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Above this corpus size the full pairwise scan samples the pair space at a fixed stride instead —
 * deterministically, no RNG, so the determinism assertion in CI keeps holding. At the shipped 160
 * documents the full scan is 12 720 cosines and completes in about a second.
 */
const FULL_SCAN_LIMIT = 2000;

/**
 * The hardest negatives in the corpus itself: every pair of distinct documents, scored, top K.
 *
 * This is the check the stride sample could never be. The corpus's whole job is to carry real
 * programmes with really overlapping vocabulary, and the pair that overlaps MOST is the exact
 * thing the threshold must clear.
 */
export interface CorpusScan {
  top: ScoredPair[];
  /** Counted during the FULL scan, never from the truncated top list. */
  atOrAboveThreshold: number;
  /**
   * The same pairs ranked by OVERLAP, restricted to those the substance guard admits.
   *
   * Restricted, because an overlap of 0.991 on a pair the runtime never evaluates is not a
   * negative the threshold has to clear — it is a pair `MIN_TOKENS` already rejected. Reporting it
   * as the hardest negative would be measuring a rule nobody runs. (That pair really exists:
   * `fundingmap:1094 ↔ 1277` at 0.991, seven embedded tokens on one side.)
   */
  topByOverlap: ScoredPair[];
  /** Distinct corpus pairs the COMBINED rule accepts. Zero, or the detector fires on real data. */
  acceptedCombined: number;
  /** The §0.1 table: which structural signals fire, and how hard their hardest negative is. */
  structuralSignals: StructuralSignalRow[];
  /** The §0.5 question: does `(url ∨ org) ∧ overlap ≥ C_low` catch anything the rule does not? */
  conjunction: ConjunctionBand;
}

/** One row of the "why structural signals cannot be the gate" table. */
export interface StructuralSignalRow {
  signal: string;
  pairsFiring: number;
  /** Cosine of the hardest negative among the pairs this signal fires on. */
  hardestCosine: number;
}

export interface ConjunctionBand {
  /** Pairs sharing a normalized application URL or a primary operating-org slug. */
  corroboratedPairs: number;
  /** …of those, the hardest overlap among pairs the substance guard admits. */
  hardestCorroboratedOverlap: number;
  /** The hardest admitted overlap over the WHOLE corpus, for comparison. */
  hardestOverlap: number;
}

/** Comparison form for a URL: scheme, `www.`, trailing slash and case are not identity. */
function normalizedUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  return value
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const primaryOrgSlug = (doc: CorpusDocument): string | null =>
  doc.operatingOrganizations?.[0]?.slug?.trim().toLowerCase() || null;

const orgSlugSet = (doc: CorpusDocument): Set<string> =>
  new Set(
    (doc.operatingOrganizations ?? [])
      .map((org) => org?.slug?.trim().toLowerCase() ?? "")
      .filter((slug) => slug !== ""),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
};

const deadlineDays = (doc: CorpusDocument): Set<string> =>
  new Set(
    (doc.deadlines ?? [])
      .map((deadline) => (deadline?.date ?? deadline?.closesAt ?? "").slice(0, 10))
      .filter((day) => day !== ""),
  );

const amountKey = (doc: CorpusDocument): string | null => {
  const currency = doc.fundingInfo?.currency ?? null;
  const budget = doc.fundingInfo?.budget ?? null;
  return currency === null || budget === null ? null : `${currency}:${budget}`;
};

const normalizedTitle = (doc: CorpusDocument): string =>
  (doc.title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Every pair of distinct corpus documents, scored on BOTH arms and against every structural
 * signal, in one pass.
 *
 * One pass because the alternative is five scans that can disagree about which pairs they saw, and
 * because the structural tables only mean anything measured against the SAME negatives the
 * threshold is chosen from.
 */
export function scanCorpusPairs(
  documents: CorpusDocument[],
  provider: SyncProvider,
  threshold: number,
  top = 20,
  rule: DuplicateRuleConfig = defaultRule(threshold),
): CorpusScan {
  const vectors = documents.map((doc) => {
    const detail = provider.embedSyncDetailed(embeddingText(doc));
    return { doc, id: doc.id, vector: detail.vector, norm: detail.norm, tokens: detail.tokens };
  });

  const total = (documents.length * (documents.length - 1)) / 2;
  const step = total > (FULL_SCAN_LIMIT * (FULL_SCAN_LIMIT - 1)) / 2 ? 7 : 1;

  const scored: ScoredPair[] = [];
  let atOrAboveThreshold = 0;
  let acceptedCombined = 0;
  let ordinal = 0;

  const signals = [
    { signal: "normalized application-url equality", firing: 0, hardest: 0 },
    { signal: "primary operating-org slug equality", firing: 0, hardest: 0 },
    { signal: "org-slug Jaccard ≥ 0.5", firing: 0, hardest: 0 },
    { signal: "deadline-day coincidence", firing: 0, hardest: 0 },
    { signal: "amount + currency equality", firing: 0, hardest: 0 },
    { signal: "exact normalized-title equality", firing: 0, hardest: 0 },
  ];
  let corroboratedPairs = 0;
  let hardestCorroboratedOverlap = 0;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      ordinal++;
      if (ordinal % step !== 0) continue;
      const left = vectors[i];
      const right = vectors[j];
      if (!left || !right) continue;

      const raw = cosineSimilarity(left.vector, right.vector);
      const similarity = round3(raw);
      const value = overlapOf({ similarity: raw, leftNorm: left.norm, rightNorm: right.norm }) ?? 0;
      const minTokens = Math.min(left.tokens, right.tokens);
      if (similarity >= threshold) atOrAboveThreshold++;
      if (
        decidePair(
          {
            similarity: raw,
            left: { norm: left.norm, tokenCount: left.tokens },
            right: { norm: right.norm, tokenCount: right.tokens },
          },
          rule,
        ).accepted
      ) {
        acceptedCombined++;
      }
      scored.push({
        label: `${left.id} ↔ ${right.id}`,
        similarity,
        overlap: round3(value),
        minTokens,
      });

      const urlMatch =
        normalizedUrl(left.doc.applicationUrl) !== null &&
        normalizedUrl(left.doc.applicationUrl) === normalizedUrl(right.doc.applicationUrl);
      const orgMatch =
        primaryOrgSlug(left.doc) !== null && primaryOrgSlug(left.doc) === primaryOrgSlug(right.doc);
      const days = deadlineDays(left.doc);
      const fires = [
        urlMatch,
        orgMatch,
        jaccard(orgSlugSet(left.doc), orgSlugSet(right.doc)) >= 0.5,
        [...deadlineDays(right.doc)].some((day) => days.has(day)),
        amountKey(left.doc) !== null && amountKey(left.doc) === amountKey(right.doc),
        normalizedTitle(left.doc) !== "" &&
          normalizedTitle(left.doc) === normalizedTitle(right.doc),
      ];
      for (let k = 0; k < signals.length; k++) {
        const row = signals[k];
        if (!row || !fires[k]) continue;
        row.firing++;
        if (similarity > row.hardest) row.hardest = similarity;
      }
      if (urlMatch || orgMatch) {
        corroboratedPairs++;
        if (minTokens >= rule.overlapMinTokens && value > hardestCorroboratedOverlap) {
          hardestCorroboratedOverlap = round3(value);
        }
      }
    }
  }

  const admitted = scored.filter((pair) => pair.minTokens >= rule.overlapMinTokens);
  const byOverlap = [...admitted].sort((a, b) => b.overlap - a.overlap);
  scored.sort((a, b) => b.similarity - a.similarity);

  return {
    top: scored.slice(0, top),
    atOrAboveThreshold,
    topByOverlap: byOverlap.slice(0, top),
    acceptedCombined,
    structuralSignals: signals.map((row) => ({
      signal: row.signal,
      pairsFiring: row.firing,
      hardestCosine: row.hardest,
    })),
    conjunction: {
      corroboratedPairs,
      hardestCorroboratedOverlap,
      hardestOverlap: byOverlap[0]?.overlap ?? 0,
    },
  };
}

/** The rule the report measures at, from the shipped per-provider defaults. */
export function defaultRule(
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD.lexical,
): DuplicateRuleConfig {
  return {
    similarityThreshold,
    overlapEnabled: true,
    overlapThreshold: DEFAULT_OVERLAP_THRESHOLD.lexical,
    overlapMinTokens: 20,
    overlapMinSimilarity: 0.35,
    suppliesNorm: true,
  };
}

/** The hardest negatives alone — the shape the held-out test wants. */
export function hardestNegatives(
  documents: CorpusDocument[],
  provider: SyncProvider,
  top = 20,
): ScoredPair[] {
  return scanCorpusPairs(documents, provider, Number.POSITIVE_INFINITY, top).top;
}

/** The hardest negatives ranked by OVERLAP, guard applied. The held-out overlap band's input. */
export function hardestOverlapNegatives(
  documents: CorpusDocument[],
  provider: SyncProvider,
  top = 20,
  rule: DuplicateRuleConfig = defaultRule(),
): ScoredPair[] {
  return scanCorpusPairs(documents, provider, Number.POSITIVE_INFINITY, top, rule).topByOverlap;
}

/**
 * Corpus pairs that share a primary operating-org slug or a normalized application URL.
 *
 * NAMED rather than left inside the anonymous full scan: these are the four funder families that
 * are the corpus's genuinely hard cases — the Arbitrum DDA tracks, the Rocket Pool GMC rounds, the
 * Road to Devcon regional programmes, the SSV grant/bounty pair. Naming them means a new family
 * arriving in the corpus surfaces as a regression with a name attached, not as a number that moved.
 */
export function structuralNegatives(documents: CorpusDocument[]): DerivedPair[] {
  const out: DerivedPair[] = [];
  for (let i = 0; i < documents.length; i++) {
    for (let j = i + 1; j < documents.length; j++) {
      const left = documents[i];
      const right = documents[j];
      if (!left || !right) continue;
      const url = normalizedUrl(left.applicationUrl);
      const sharesUrl = url !== null && url === normalizedUrl(right.applicationUrl);
      const org = primaryOrgSlug(left);
      const sharesOrg = org !== null && org === primaryOrgSlug(right);
      if (sharesUrl || sharesOrg) out.push({ label: `${left.id} ↔ ${right.id}`, left, right });
    }
  }
  return out;
}

// ── the stub attack ───────────────────────────────────────────────────────────────
/**
 * The stub sizes the attacker may choose from — every k from 1 to 120, per target.
 *
 * DENSE ON PURPOSE, and this was measured rather than assumed: a coarse sample
 * (`{2,3,5,8,12,20,30,60}`) handicaps the CHEAP arm more than the expensive one — it missed an
 * arm-A win on 2 of 160 targets while still finding the arm-B win, and reported a marginal
 * exposure of 2 that does not exist. Sampling the attacker's search space is not a conservative
 * simplification when the headline number is a DIFFERENCE between two arms; it biases that
 * difference upward. Fixed and deterministic, so this stays a permanent CI regression.
 */
const STUB_SIZES = Array.from({ length: 120 }, (_, index) => index + 1);

export interface StubAttackReport {
  /** Corpus documents with enough distinct vocabulary to be a target at all. */
  targets: number;
  /** Targets an attacker reaches through the ALREADY-SHIPPED cosine arm. */
  armAWins: number;
  /** Targets an attacker reaches through the overlap arm, guard applied. */
  armBWins: number;
  /** …and the same with the substance guard removed. This is what the guard buys. */
  armBWinsWithoutTokenGuard: number;
  /** Reachable through arm B but NOT already through arm A. THE NUMBER THIS CHANGE OWNS. */
  marginalWins: number;
  /** Median smallest winning stub size on arm A — how cheap the pre-existing attack is. */
  medianArmAStubSize: number;
}

/**
 * For each corpus document, the cheapest stub that gets it flagged as somebody else's duplicate.
 *
 * The attack: take the target's own rarest terms (highest idf against the SAME frozen table the
 * detector ships, which is public information), publish them as a listing, and let the detector
 * pair the two. It is the adversarial case for any bag-of-words duplicate detector, and it is
 * measured here rather than argued about.
 *
 * Read `armAWins` FIRST. It is the exposure the shipped detector already has and this change does
 * not touch; `marginalWins` is the exposure this change is accountable for.
 */
export function deriveStubAttacks(
  documents: CorpusDocument[],
  provider: SyncProvider,
  rule: DuplicateRuleConfig = defaultRule(),
): StubAttackReport {
  const unguarded: DuplicateRuleConfig = { ...rule, overlapMinTokens: 1 };
  const idf = idfRanker();

  let targets = 0;
  let armAWins = 0;
  let armBWins = 0;
  let armBWinsWithoutTokenGuard = 0;
  let marginalWins = 0;
  const armAStubSizes: number[] = [];

  for (const doc of documents) {
    const text = embeddingText(doc);
    const ranked = [...new Set(tokenize(text))].sort((a, b) => idf(b) - idf(a));
    if (ranked.length < 2) continue;
    targets++;

    const target = provider.embedSyncDetailed(text);
    let armA = false;
    let armB = false;
    let armBUnguarded = false;
    let cheapestArmA: number | undefined;

    for (const size of STUB_SIZES) {
      if (size > ranked.length) continue;
      // The stub IS the tokens: no title furniture, no organization, nothing the attacker would
      // have to invent. `embeddingText` composes exactly what is given it.
      const stubText = ranked.slice(0, size).join(" ");
      const stub = provider.embedSyncDetailed(embeddingText({ summary: stubText }));
      const similarity = cosineSimilarity(stub.vector, target.vector);
      const inputs = {
        similarity,
        left: { norm: stub.norm, tokenCount: stub.tokens },
        right: { norm: target.norm, tokenCount: target.tokens },
      };
      if (similarity >= rule.similarityThreshold) {
        armA = true;
        if (cheapestArmA === undefined) cheapestArmA = size;
      }
      if (decidePair(inputs, rule).arm === "overlap") armB = true;
      if (decidePair(inputs, unguarded).arm === "overlap") armBUnguarded = true;
    }

    if (armA) armAWins++;
    if (armB) armBWins++;
    if (armBUnguarded) armBWinsWithoutTokenGuard++;
    if (armB && !armA) marginalWins++;
    if (cheapestArmA !== undefined) armAStubSizes.push(cheapestArmA);
  }

  armAStubSizes.sort((a, b) => a - b);
  const mid = Math.floor(armAStubSizes.length / 2);
  const medianArmAStubSize =
    armAStubSizes.length === 0
      ? 0
      : armAStubSizes.length % 2 === 1
        ? (armAStubSizes[mid] ?? 0)
        : ((armAStubSizes[mid - 1] ?? 0) + (armAStubSizes[mid] ?? 0)) / 2;

  return {
    targets,
    armAWins,
    armBWins,
    armBWinsWithoutTokenGuard,
    marginalWins,
    medianArmAStubSize,
  };
}

/**
 * `idf(token)` against the FROZEN committed table — the same public information the detector uses
 * and the same an attacker would have. Built once per call site rather than per token.
 */
function idfRanker(): (token: string) => number {
  const table = committedIdfTable as { documentCount: number; df: Record<string, number> };
  const df = new Map(Object.entries(table.df));
  return (token: string) => Math.log((table.documentCount + 1) / ((df.get(token) ?? 0) + 1)) + 1;
}

export interface MutationReport {
  id: MutationId;
  label: string;
  count: number;
  worst: number;
  median: number;
  recallAtThreshold: number;
  recallAtZeroFp: number;
  /** Recall under the COMBINED rule — both arms, the substance guard applied. */
  recallCombined: number;
  /** The worst (lowest) overlap on this rung, which is what `OVERLAP_MIN` has to clear. */
  worstOverlap: number;
  /** The fewest distinct tokens any pair on this rung had, against `MIN_TOKENS`. */
  minTokens: number;
}

export interface SweepResult {
  provider: string;
  model: string;
  threshold: number;
  positives: ScoredPair[];
  negatives: ScoredPair[];
  hardestCorpusNegatives: ScoredPair[];
  /** Max over the stride negatives AND the full corpus scan — the honest number. */
  bestNegative: number;
  worstPositive: number;
  margin: number;
  positivesAbove: number;
  negativesBelow: number;
  /** Distinct corpus pairs scoring at or above the configured threshold. Zero or it fires on real data. */
  corpusPairsAtOrAboveThreshold: number;
  /** Just above the hardest corpus negative: the cheapest threshold with zero corpus false positives. */
  zeroFpPoint: number;
  mutations: MutationReport[];

  // ── the overlap arm ─────────────────────────────────────────────────────────────
  /** The rule the combined numbers below were measured at. */
  rule: DuplicateRuleConfig;
  /** Hardest overlap among corpus negatives the substance guard admits. */
  hardestNegativeOverlap: number;
  /** Lowest overlap across every mutation rung — the positive side of the overlap band. */
  worstPositiveOverlap: number;
  /** `worstPositiveOverlap − hardestNegativeOverlap`. */
  overlapBand: number;
  /** Distinct corpus pairs the COMBINED rule accepts. Zero, or it fires on real data. */
  corpusPairsAcceptedCombined: number;
  /** The pairs ranked by overlap, guard applied. */
  hardestCorpusOverlaps: ScoredPair[];
  structuralSignals: StructuralSignalRow[];
  conjunction: ConjunctionBand;
  stubAttack: StubAttackReport;
  /** The named funder families, scored on both arms. */
  structuralNegativeScores: ScoredPair[];
}

interface SyncProvider {
  id: string;
  model: string;
  embedSync(text: string): number[];
  embedSyncDetailed(text: string): { vector: number[]; norm: number; tokens: number };
}

/** Score every derived pair and the whole corpus with one provider. Pure and synchronous. */
export function sweep(
  documents: CorpusDocument[],
  threshold: number,
  provider: SyncProvider = new LexicalEmbeddingProvider(),
): SweepResult {
  const rule = defaultRule(threshold);
  // Every pair now carries the three numbers the runtime decides on, computed exactly the way the
  // runtime computes them — the norm and token count come from the provider, and the overlap comes
  // from the SAME pure function the service calls. A report that recomputed the rule its own way
  // would be evidence for a rule nobody runs.
  const score = (pair: DerivedPair): ScoredPair => {
    const left = provider.embedSyncDetailed(embeddingText(pair.left));
    const right = provider.embedSyncDetailed(embeddingText(pair.right));
    const raw = cosineSimilarity(left.vector, right.vector);
    return {
      label: pair.label,
      similarity: round3(raw),
      overlap: round3(
        overlapOf({ similarity: raw, leftNorm: left.norm, rightNorm: right.norm }) ?? 0,
      ),
      minTokens: Math.min(left.tokens, right.tokens),
    };
  };
  const accepts = (pair: ScoredPair): boolean =>
    pair.similarity >= rule.similarityThreshold ||
    (pair.minTokens >= rule.overlapMinTokens &&
      pair.similarity >= rule.overlapMinSimilarity &&
      pair.overlap >= rule.overlapThreshold);

  const pairs = derivePairs(documents);
  const positives = pairs.positive.map(score);
  const negatives = pairs.negative.map(score);
  const scan = scanCorpusPairs(documents, provider, threshold, 20, rule);
  const hardest = scan.top;

  const worstPositive = Math.min(...positives.map((p) => p.similarity));
  const bestNegative = Math.max(
    ...negatives.map((n) => n.similarity),
    ...hardest.map((n) => n.similarity),
  );
  const hardestCorpus = hardest[0]?.similarity ?? 0;
  const zeroFpPoint = round3(hardestCorpus + 0.001);

  const mutations: MutationReport[] = (Object.keys(MUTATIONS) as MutationId[]).map((id) => {
    const scoredPairs = deriveMutationPositives(documents, id).map(score);
    const sims = scoredPairs.map((p) => p.similarity).sort((a, b) => a - b);
    const mid = Math.floor(sims.length / 2);
    const median =
      sims.length % 2 === 1
        ? (sims[mid] ?? 0)
        : round3(((sims[mid - 1] ?? 0) + (sims[mid] ?? 0)) / 2);
    return {
      id,
      label: MUTATIONS[id].label,
      count: sims.length,
      worst: sims[0] ?? 0,
      median,
      recallAtThreshold: sims.filter((s) => s >= threshold).length,
      recallAtZeroFp: sims.filter((s) => s >= zeroFpPoint).length,
      recallCombined: scoredPairs.filter(accepts).length,
      worstOverlap: Math.min(...scoredPairs.map((pair) => pair.overlap)),
      minTokens: Math.min(...scoredPairs.map((pair) => pair.minTokens)),
    };
  });

  return {
    provider: provider.id,
    model: provider.model,
    threshold,
    positives,
    negatives,
    hardestCorpusNegatives: hardest,
    worstPositive,
    bestNegative,
    margin: round3(worstPositive - bestNegative),
    positivesAbove: positives.filter((p) => p.similarity >= threshold).length,
    negativesBelow: negatives.filter((n) => n.similarity < threshold).length,
    corpusPairsAtOrAboveThreshold: scan.atOrAboveThreshold,
    rule,
    hardestNegativeOverlap: scan.topByOverlap[0]?.overlap ?? 0,
    worstPositiveOverlap: Math.min(...mutations.map((rung) => rung.worstOverlap)),
    overlapBand: round3(
      Math.min(...mutations.map((rung) => rung.worstOverlap)) -
        (scan.topByOverlap[0]?.overlap ?? 0),
    ),
    corpusPairsAcceptedCombined: scan.acceptedCombined,
    hardestCorpusOverlaps: scan.topByOverlap,
    structuralSignals: scan.structuralSignals,
    conjunction: scan.conjunction,
    stubAttack: deriveStubAttacks(documents, provider, rule),
    structuralNegativeScores: structuralNegatives(documents)
      .map(score)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 10),
    zeroFpPoint,
    mutations,
  };
}

export function loadCorpus(path = CORPUS_PATH): CorpusDocument[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { documents: CorpusDocument[] };
  return parsed.documents;
}

/** True only when THIS file is the process entry — an import must never trigger the CLI. */
const isCliEntry =
  !process.env.VITEST &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

// CLI entry — never on import: `build-idf-table.ts` imports `loadCorpus` from here, and a table
// regeneration that transitively ran the whole sweep (and inherited its exit code) would make a
// successful regeneration report failure exactly when the old weighting no longer separates.
if (isCliEntry) {
  const provider: EmbeddingProvider = "lexical";
  const threshold = DEFAULT_SIMILARITY_THRESHOLD[provider];
  const corpus = loadCorpus();
  const result = sweep(corpus, threshold);

  console.log(
    `provider: ${result.provider} (${result.model})   configured threshold: ${result.threshold}`,
  );
  console.log("\npositives (same programme, reworded — M0):");
  for (const p of result.positives) console.log(`  ${p.similarity.toFixed(3)}  ${p.label}`);
  console.log("\nstride negatives (different programmes):");
  for (const n of result.negatives) console.log(`  ${n.similarity.toFixed(3)}  ${n.label}`);
  console.log("\nhardest corpus negatives (all distinct pairs, top of the scan):");
  for (const n of result.hardestCorpusNegatives.slice(0, 10))
    console.log(`  ${n.similarity.toFixed(3)}  ${n.label}`);
  console.log(
    `\nworst positive ${result.worstPositive.toFixed(3)}  hardest negative ${result.bestNegative.toFixed(3)}  margin ${result.margin.toFixed(3)}`,
  );
  console.log(
    `at ${result.threshold}: ${result.positivesAbove}/${result.positives.length} positives detected, ` +
      `${result.corpusPairsAtOrAboveThreshold} corpus false positives`,
  );
  console.log(`zero-false-positive point: ${result.zeroFpPoint.toFixed(3)}`);
  console.log("\nmutation ladder (recall @ threshold / @ zero-FP point / COMBINED rule):");
  for (const m of result.mutations) {
    console.log(
      `  ${m.id}  worst ${m.worst.toFixed(3)}  median ${m.median.toFixed(3)}  ` +
        `${m.recallAtThreshold}/${m.count} / ${m.recallAtZeroFp}/${m.count} / ` +
        `${m.recallCombined}/${m.count}  overlap ${m.worstOverlap.toFixed(3)}  ` +
        `tokens ${m.minTokens}  ${m.label}`,
    );
  }

  // ── the overlap arm, and every alternative it was chosen over ───────────────────
  const rule = result.rule;
  console.log(
    `\noverlap arm: threshold ${rule.overlapThreshold}  min tokens ${rule.overlapMinTokens}  ` +
      `cosine floor ${rule.overlapMinSimilarity}`,
  );
  console.log("hardest corpus negatives BY OVERLAP (substance guard applied):");
  for (const n of result.hardestCorpusOverlaps.slice(0, 10)) {
    console.log(
      `  ${n.overlap.toFixed(3)}  (cos ${n.similarity.toFixed(3)}, ${n.minTokens} tok)  ${n.label}`,
    );
  }
  console.log(
    `overlap band: worst positive ${result.worstPositiveOverlap.toFixed(3)}  ` +
      `hardest negative ${result.hardestNegativeOverlap.toFixed(3)}  ` +
      `band ${result.overlapBand.toFixed(3)}`,
  );
  console.log(
    `combined rule: ${result.corpusPairsAcceptedCombined} corpus false positives, ` +
      `${result.mutations.reduce((n, m) => n + m.recallCombined, 0)}/` +
      `${result.mutations.reduce((n, m) => n + m.count, 0)} positives detected`,
  );

  console.log("\nwhy structural signals are NOT the gate (pairs firing / hardest cosine):");
  for (const row of result.structuralSignals) {
    console.log(
      `  ${row.pairsFiring.toString().padStart(5)}  ${row.hardestCosine.toFixed(3)}  ${row.signal}`,
    );
  }
  console.log("\nthe named funder families (the corpus's genuinely hard negatives):");
  for (const n of result.structuralNegativeScores.slice(0, 6)) {
    console.log(
      `  cos ${n.similarity.toFixed(3)}  overlap ${n.overlap.toFixed(3)}  ` +
        `(${n.minTokens} tok)  ${n.label}`,
    );
  }

  console.log(
    `\nconjunction band (url ∨ org) ∧ overlap ≥ C_low: ${result.conjunction.corroboratedPairs} ` +
      `corroborated pairs, hardest admitted overlap ${result.conjunction.hardestCorroboratedOverlap.toFixed(3)} ` +
      `vs global hardest ${result.conjunction.hardestOverlap.toFixed(3)}`,
  );
  console.log(
    result.conjunction.hardestCorroboratedOverlap >= result.conjunction.hardestOverlap
      ? "  → a corroborated band would have to sit at or above the GLOBAL hardest negative, while every rung is already far above it. It catches nothing, and a stub attacker copies applicationUrl for free, so it would make the attack easier."
      : "  → a corroborated band has room below the global hardest negative. RE-MEASURE before rejecting it.",
  );

  const stub = result.stubAttack;
  console.log(
    `\nstub attack (${stub.targets} targets, attacker free to choose k ∈ [${STUB_SIZES[0]}, ${STUB_SIZES[STUB_SIZES.length - 1]}] highest-idf tokens per target):`,
  );
  console.log(
    `  arm A (ALREADY SHIPPED): ${stub.armAWins}/${stub.targets} ` +
      `at a median winning stub of ${stub.medianArmAStubSize} tokens`,
  );
  console.log(`  arm B, guard applied:    ${stub.armBWins}/${stub.targets}`);
  console.log(`  arm B, NO token guard:   ${stub.armBWinsWithoutTokenGuard}/${stub.targets}`);
  console.log(
    `  arm-B-only MARGINAL:     ${stub.marginalWins}/${stub.targets}  ← the number this arm owns; arm A's figure is a pre-existing property of the shipped detector and is filed separately`,
  );
  // The exponent the model pins is a point on a curve, and the curve is printed so the choice
  // stays inspectable: 0 is the historical unweighted bag, 2 is what ships.
  console.log("\nidf exponent sweep (worst positive / hardest negative / band):");
  for (const exponent of [0, 1, 1.5, 2, 2.5]) {
    const swept = sweep(corpus, threshold, new LexicalEmbeddingProvider({ idfExponent: exponent }));
    console.log(
      `  idf^${exponent}  ${swept.worstPositive.toFixed(3)} / ${swept.bestNegative.toFixed(3)} / ${swept.margin.toFixed(3)}`,
    );
  }

  if (result.margin <= 0) {
    console.error(
      "\n✗ the classes OVERLAP — no single threshold separates them, and the operating point cannot be settled from this corpus.",
    );
    process.exitCode = 1;
  } else {
    const midpoint = Math.round(((result.worstPositive + result.bestNegative) / 2) * 100) / 100;
    console.log(`\nmidpoint of the separating band: ${midpoint.toFixed(2)}`);
  }
}
