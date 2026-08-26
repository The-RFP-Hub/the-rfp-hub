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
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SIMILARITY_THRESHOLD, type EmbeddingProvider } from "../src/config.js";
import {
  LexicalEmbeddingProvider,
  cosineSimilarity,
} from "../src/modules/services/dedupe/embedding-provider.js";
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

export type MutationId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5";

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
    apply: (t) => reverseTriples(truncateTo(dropEvery(substitute(t, SUBSTITUTIONS_HEAVY), 3), 0.5)),
  },
};

export interface CorpusDocument extends EmbeddableOpportunity {
  id: string;
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
}

export function scanCorpusPairs(
  documents: CorpusDocument[],
  provider: { embedSync(text: string): number[] },
  threshold: number,
  top = 20,
): CorpusScan {
  const vectors = documents.map((doc) => ({
    id: doc.id,
    vector: provider.embedSync(embeddingText(doc)),
  }));

  const total = (documents.length * (documents.length - 1)) / 2;
  const step = total > (FULL_SCAN_LIMIT * (FULL_SCAN_LIMIT - 1)) / 2 ? 7 : 1;

  const scored: ScoredPair[] = [];
  let atOrAboveThreshold = 0;
  let ordinal = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      ordinal++;
      if (ordinal % step !== 0) continue;
      const left = vectors[i];
      const right = vectors[j];
      if (!left || !right) continue;
      const similarity = round3(cosineSimilarity(left.vector, right.vector));
      if (similarity >= threshold) atOrAboveThreshold++;
      scored.push({ label: `${left.id} ↔ ${right.id}`, similarity });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return { top: scored.slice(0, top), atOrAboveThreshold };
}

/** The hardest negatives alone — the shape the held-out test wants. */
export function hardestNegatives(
  documents: CorpusDocument[],
  provider: { embedSync(text: string): number[] },
  top = 20,
): ScoredPair[] {
  return scanCorpusPairs(documents, provider, Number.POSITIVE_INFINITY, top).top;
}

export interface MutationReport {
  id: MutationId;
  label: string;
  count: number;
  worst: number;
  median: number;
  recallAtThreshold: number;
  recallAtZeroFp: number;
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
}

interface SyncProvider {
  id: string;
  model: string;
  embedSync(text: string): number[];
}

/** Score every derived pair and the whole corpus with one provider. Pure and synchronous. */
export function sweep(
  documents: CorpusDocument[],
  threshold: number,
  provider: SyncProvider = new LexicalEmbeddingProvider(),
): SweepResult {
  const score = (pair: DerivedPair): ScoredPair => ({
    label: pair.label,
    similarity: round3(
      cosineSimilarity(
        provider.embedSync(embeddingText(pair.left)),
        provider.embedSync(embeddingText(pair.right)),
      ),
    ),
  });

  const pairs = derivePairs(documents);
  const positives = pairs.positive.map(score);
  const negatives = pairs.negative.map(score);
  const scan = scanCorpusPairs(documents, provider, threshold);
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
  console.log("\nmutation ladder (recall @ threshold / @ zero-FP point):");
  for (const m of result.mutations) {
    console.log(
      `  ${m.id}  worst ${m.worst.toFixed(3)}  median ${m.median.toFixed(3)}  ` +
        `${m.recallAtThreshold}/${m.count} / ${m.recallAtZeroFp}/${m.count}  ${m.label}`,
    );
  }
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
