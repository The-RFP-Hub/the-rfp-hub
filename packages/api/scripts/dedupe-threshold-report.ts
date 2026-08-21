/**
 * Where the duplicate threshold comes from — evidence, not two hand-picked examples.
 *
 *   pnpm --filter @the-rfp-hub/api dedupe:threshold
 *
 * A threshold is a property of an EMBEDDING SPACE, not a universal constant: the same cosine means
 * different things to a learned 1 536-dimension model and to a hashed token bag. So this sweeps
 * pairs derived from the committed corpus and reports the two numbers that actually decide the
 * operating point — the WORST positive and the BEST negative — and the margin between them.
 *
 * HOW THE PAIRS ARE MADE, and why this is honest rather than circular:
 *
 *   POSITIVES are the realistic duplicate: the same programme, republished by somebody else in
 *   their own words. That is what a re-listing looks like — a title carrying the site's furniture,
 *   a body that says the same things with a quarter of the words dropped and a handful of the
 *   domain's near-synonyms swapped. It is deliberately NOT a copy with whitespace changed, which
 *   any threshold at all would separate and which would prove nothing.
 *
 *   NEGATIVES are distinct corpus records paired at a fixed stride. They are real programmes with
 *   real overlapping vocabulary — "grant", "ecosystem", "application", "deadline" — which is the
 *   only kind of negative worth measuring: two documents with nothing in common are separated by
 *   any threshold.
 *
 * The paraphrase is DETERMINISTIC (a fixed substitution table and a fixed drop stride, no RNG), so
 * a rerun of this script and the CI assertion in `test/unit/dedupe-threshold.test.ts` are looking at
 * the same pairs. The CI test is the part that keeps the settled number honest as the corpus grows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SIMILARITY_THRESHOLD, type EmbeddingProvider } from "../src/config.js";
import {
  DeterministicEmbeddingProvider,
  cosineSimilarity,
} from "../src/modules/services/dedupe/embedding-provider.js";
import { type EmbeddableOpportunity, embeddingText } from "../src/modules/shared/embedding-text.js";

/** The corpus this repository ships, and the only input this script reads. */
const CORPUS_PATH = fileURLToPath(new URL("../data/seed-corpus.json", import.meta.url));

/**
 * Near-synonyms a second publisher plausibly reaches for.
 *
 * Small and domain-specific on purpose: a large substitution table would be measuring the table
 * rather than the space.
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
 * Every sixth word dropped — a rewrite that says the same thing more briefly.
 *
 * Not more than that, deliberately. Dropping a quarter of the words on top of the substitutions
 * models a rewrite from scratch rather than a re-listing, and the class it would measure is not the
 * class the detector is for: the duplicate this system actually sees is one programme entered twice.
 */
const DROP_STRIDE = 6;

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

function paraphrase(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out
    .split(/\s+/)
    .filter((_, index) => index % DROP_STRIDE !== 0)
    .join(" ");
}

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

/**
 * The fixture pairs, from the corpus, deterministically.
 *
 * `count` positives and `count` negatives. Records with too little text to paraphrase are skipped:
 * a two-sentence entry produces a paraphrase that shares almost nothing, which would be measuring
 * the corpus's thin records rather than the detector.
 */
export function derivePairs(documents: CorpusDocument[], count = 12): DerivedPairs {
  // The RICHER of the two bodies, not `summary ?? description`: most corpus records carry a short
  // one-line summary and a long description, so preferring the summary would have measured the
  // detector against a sentence and called it evidence.
  const bodyOf = (doc: CorpusDocument): string => {
    const summary = doc.summary ?? "";
    const description = doc.description ?? "";
    return summary.length >= description.length ? summary : description;
  };
  const usable = documents.filter((doc) => words(bodyOf(doc)) >= 60);

  const positive: DerivedPair[] = [];
  for (const doc of usable.slice(0, count)) {
    const body = bodyOf(doc);
    positive.push({
      label: `${doc.id} ↔ paraphrase`,
      // BOTH sides are normalised onto the same body. `embeddingText` prefers `summary` and falls
      // back to a truncated `description`, so pairing a record's one-line summary against a
      // paraphrase of its long description would be comparing a sentence to an essay and reporting
      // the length difference as dissimilarity.
      left: { ...doc, summary: body, description: body },
      right: {
        ...doc,
        // The site's furniture on the end, which is how a republished title normally reads.
        title: `${paraphrase(doc.title ?? "")} | ${doc.operatingOrganizations?.[0]?.name ?? "Directory"}`,
        summary: paraphrase(body),
        description: paraphrase(body),
      },
    });
  }

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

export interface SweepResult {
  provider: string;
  threshold: number;
  positives: { label: string; similarity: number }[];
  negatives: { label: string; similarity: number }[];
  worstPositive: number;
  bestNegative: number;
  margin: number;
  positivesAbove: number;
  negativesBelow: number;
}

/** Score every pair with one provider. Pure and synchronous for the deterministic provider. */
export function sweep(pairs: DerivedPairs, threshold: number): SweepResult {
  const provider = new DeterministicEmbeddingProvider();
  const score = (pair: DerivedPair) => ({
    label: pair.label,
    similarity:
      Math.round(
        cosineSimilarity(
          provider.embedSync(embeddingText(pair.left)),
          provider.embedSync(embeddingText(pair.right)),
        ) * 1000,
      ) / 1000,
  });

  const positives = pairs.positive.map(score);
  const negatives = pairs.negative.map(score);
  const worstPositive = Math.min(...positives.map((p) => p.similarity));
  const bestNegative = Math.max(...negatives.map((n) => n.similarity));

  return {
    provider: provider.id,
    threshold,
    positives,
    negatives,
    worstPositive,
    bestNegative,
    margin: Math.round((worstPositive - bestNegative) * 1000) / 1000,
    positivesAbove: positives.filter((p) => p.similarity >= threshold).length,
    negativesBelow: negatives.filter((n) => n.similarity < threshold).length,
  };
}

export function loadCorpus(path = CORPUS_PATH): CorpusDocument[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { documents: CorpusDocument[] };
  return parsed.documents;
}

// CLI entry — skipped under Vitest so the test can import `derivePairs`/`sweep` without a run.
if (!process.env.VITEST) {
  const provider: EmbeddingProvider = "deterministic";
  const threshold = DEFAULT_SIMILARITY_THRESHOLD[provider];
  const result = sweep(derivePairs(loadCorpus()), threshold);

  console.log(`provider: ${result.provider}   configured threshold: ${result.threshold}`);
  console.log("\npositives (same programme, reworded):");
  for (const p of result.positives) console.log(`  ${p.similarity.toFixed(3)}  ${p.label}`);
  console.log("\nnegatives (different programmes):");
  for (const n of result.negatives) console.log(`  ${n.similarity.toFixed(3)}  ${n.label}`);
  console.log(
    `\nworst positive ${result.worstPositive.toFixed(3)}  best negative ${result.bestNegative.toFixed(3)}  margin ${result.margin.toFixed(3)}`,
  );
  console.log(
    `at ${result.threshold}: ${result.positivesAbove}/${result.positives.length} positives detected, ${result.negativesBelow}/${result.negatives.length} negatives rejected`,
  );
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
