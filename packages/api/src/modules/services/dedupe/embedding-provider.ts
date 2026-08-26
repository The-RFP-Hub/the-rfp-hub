/**
 * The embedding provider: a lexical, in-process featurizer — no model, no vendor, no network.
 *
 * Duplicate detection needs a vector for a piece of text. This one is a signed-hashed token bag
 * with TF-IDF weighting against a frozen document-frequency table (`idf-table.json`, regenerated
 * from the committed corpus by `scripts/build-idf-table.ts`). It runs everywhere the tests run,
 * costs nothing per call, and sends nothing anywhere — which is now a stated property of the
 * product, not an implementation detail.
 *
 * WHY THE WEIGHTS ARE WHAT THEY ARE, measured rather than assumed (`scripts/
 * dedupe-threshold-report.ts`, against every distinct pair of the committed corpus):
 *
 *   - The plain `1 + log(tf)` bag separated this corpus by a band of just 0.018 — two unrelated
 *     bug bounties scored 0.893 against a worst true-duplicate of 0.911, and sixteen real corpus
 *     pairs sat above the configured threshold. Domain boilerplate ("submit a report", "rewards
 *     are paid") dominated the vectors.
 *   - Multiplying each token's weight by idf^2 moves the hardest corpus negative to 0.592 while
 *     the worst positive stays at 0.913 — a band of 0.321, and zero corpus pairs above the
 *     operating point. The exponent is aggressive on purpose and pinned as a named constant
 *     (`IDF_EXPONENT`); the report sweeps it so the choice stays visibly a point on a curve.
 *
 * WHY THE DF TABLE IS FROZEN. Live document frequencies shift on every write; every shift changes
 * every vector and every `content_hash`, and the backfill cursor would select the whole table
 * forever. A frozen table makes the weighting part of the MODEL IDENTITY: refreshing it is a
 * deliberate release event — rerun the generator, bump `model`, and the ordinary backfill
 * machinery re-embeds everything exactly once (`ensureEmbedding`'s content-hash rule).
 *
 * THE THRESHOLD IS A PROPERTY OF THE SPACE, NOT A CONSTANT. A cosine of 0.8 means something
 * different in every weighting; the default is per-provider (`DEFAULT_SIMILARITY_THRESHOLD` in
 * config.ts) and the operating point is settled by the threshold report against the corpus.
 */
import { createHash } from "node:crypto";
import { type EmbeddingConfig, config as defaultConfig } from "../../../config.js";
// A plain JSON import: `moduleResolution: Bundler` resolves it, and both runtimes this code meets
// (tsx in development, the tsup/esbuild bundle in the image) INLINE the file — which is what makes
// the frozen table part of the artefact rather than a path the runtime stage must remember to copy.
import committedIdfTable from "./idf-table.json";

/** Every stored vector is this wide — `opportunity_embeddings.embedding` is `vector(1536)`. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * The IDF exponent the shipping model uses.
 *
 * 2 is aggressive — cosine of two idf-weighted vectors already yields idf² per matching term, so
 * this is idf⁴ in the similarity — and it is justified by measurement, not orthodoxy: it is the
 * only setting at which the evasive re-listing (heavy synonyms plus compression) stays separable
 * from the corpus's hardest honest negatives. Exponent 0 reproduces the historical unweighted bag
 * exactly, which the regression test uses to pin that this featurizer is the old one plus a
 * weight function and nothing else.
 */
export const IDF_EXPONENT = 2;

export interface EmbeddingProvider {
  /**
   * Stored on the embedding row and hashed into `content_hash`.
   *
   * Two weightings' vectors are not in comparable spaces, so a row that survived a model change
   * must not look current. The id and model string are what make that detectable.
   */
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Whether this provider can report the PRE-NORMALISATION L2 norm and the distinct-token count
   * of a piece of text.
   *
   * A DECLARED CAPABILITY, not something the caller infers from an absent method. The overlap arm
   * of duplicate detection (`duplicate-signal.ts`) needs both numbers; the backfill's pending
   * predicate selects rows that are missing them. A provider that cannot supply them must be able
   * to say so, or the backfill would select rows it can never repair and the cursor would never
   * retire — which `docs/jobs.md` forbids. `false` degrades the overlap arm to OFF, never to a
   * guess.
   */
  readonly suppliesNorm: boolean;
  /** One vector, L2-normalised, `dimensions` long. Rejects rather than returns a wrong width. */
  embed(text: string): Promise<number[]>;
  /**
   * The same vector, plus the two scalars the overlap arm decides on.
   *
   * REQUIRED on the interface rather than optional: `suppliesNorm === false` returns nulls, which
   * is a provider *declaring* what it cannot do. An optional method leaves "absent" and "supplies
   * nothing" indistinguishable at the call site, and the pending predicate would then have no
   * honest way to gate itself.
   */
  embedDetailed(text: string): Promise<EmbeddingDetail>;
}

/**
 * A vector and the two scalars the overlap arm needs beside it.
 *
 * `norm` is the L2 norm of the vector BEFORE normalisation — the magnitude the stored unit vector
 * threw away, which is what makes a length-corrected comparison possible at all. `tokens` is the
 * count of DISTINCT tokens the text contributed, which is the substance guard's input. Both are
 * `null` from a provider whose `suppliesNorm` is `false`.
 */
export interface EmbeddingDetail {
  vector: number[];
  norm: number | null;
  tokens: number | null;
}

/** The shape `idf-table.json` commits — kept structural so tests can hand in synthetic tables. */
export interface IdfTable {
  documentCount: number;
  df: Record<string, number>;
}

/**
 * L2-normalise in place, returning the vector AND the norm it was divided by.
 *
 * The norm used to be computed here and discarded. It is now returned instead — the arithmetic is
 * byte-for-byte what it always was, so no vector, no `content_hash` and no model string changes;
 * the only difference is that the caller may keep a number this function already had. A zero
 * vector stays zero (there is nothing to point at) and reports a norm of 0.
 */
function normalize(vector: number[]): { vector: number[]; norm: number } {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return { vector, norm: 0 };
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / norm;
  return { vector, norm };
}

/**
 * Lowercased alphanumeric tokens.
 *
 * Deliberately the same shape as `field-diff.ts`'s tokenizer without its stop list: a stop list is
 * a ranking decision for comparing DIFFERENT records, and this is building a vector, where IDF
 * already does the down-weighting a stop list would fake.
 *
 * EXPORTED because the document-frequency table is built from the committed corpus by
 * `scripts/build-idf-table.ts`, and a df table produced by any other tokenization would weight a
 * vocabulary the featurizer never sees. One tokenizer, two call sites, no drift.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 1);
}

/**
 * The lexical provider: signed feature hashing over a TF-IDF-weighted term bag.
 *
 * Each token is hashed to TWO (index, sign) pairs rather than one. A single hash puts every
 * collision straight into one coordinate with a fixed sign, so two unrelated documents that happen
 * to collide on a frequent term get a similarity floor they did not earn. Two independent draws
 * halve the variance of the estimate for the same cost, which is the standard reason to do it.
 *
 * `1 + log(tf)` rather than raw counts: a word repeated forty times in a long description is not
 * forty times as much evidence about which programme this is. The idf factor is what stops the
 * domain's boilerplate from mattering at all — a token in half the corpus carries almost nothing;
 * a token in one document carries the match.
 *
 * A token absent from the frozen table is treated as maximally rare (df 0): unseen vocabulary is
 * exactly the discriminating kind.
 */
export class LexicalEmbeddingProvider implements EmbeddingProvider {
  readonly id = "lexical";
  /**
   * ALWAYS true, and the norm/token count are therefore ALWAYS numbers, never null.
   *
   * Both fall out of a computation `embedSync` already performs — `normalize()` computed the norm
   * and threw it away, and the distinct-token count is the size of the map it already built. THIS
   * IS NOT A MODEL CHANGE: the weights, the tokenizer, the hashing, the draws, the dimensions and
   * therefore every vector and every `content_hash` are untouched, and the `model` string does not
   * move. Nothing is re-embedded because of this. That matters enough to say here rather than in a
   * commit message, because this file's own header calls a weighting change a release event and a
   * reader arriving at `suppliesNorm` needs to know this is not one.
   */
  readonly suppliesNorm = true;
  /**
   * The weighting scheme PLUS a digest of the exact table (and exponent) the weights came from.
   *
   * The docs call refreshing the idf table "a deliberate release event alongside a model-string
   * bump" — this makes the bump impossible to forget rather than something to remember: a
   * regenerated table changes the digest, the digest changes the model, the model changes every
   * `content_hash`, and the backfill re-embeds. A manual constant here would let old rows keep
   * matching hashes while new rows used different weights under the same identity — two
   * incomparable spaces silently sharing one index.
   */
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  private readonly exponent: number;
  private readonly documentCount: number;
  private readonly df: Map<string, number>;

  constructor(options: { idfExponent?: number; table?: IdfTable } = {}) {
    this.exponent = options.idfExponent ?? IDF_EXPONENT;
    const table = options.table ?? (committedIdfTable as IdfTable);
    const digest = createHash("sha256")
      .update(JSON.stringify({ n: table.documentCount, df: table.df, e: this.exponent }), "utf8")
      .digest("hex")
      .slice(0, 12);
    this.model = `tfidf-hashed-v1+${digest}`;
    this.documentCount = table.documentCount;
    // A Map, never the raw JSON object: `df["constructor"]` on a plain object answers
    // `Object.prototype.constructor` — a function — and one hostile-looking but perfectly
    // ordinary token ("constructor" appears in real developer-tooling listings) would turn its
    // idf into NaN, poison every coordinate through normalisation, and leave that entry's
    // detection permanently failing. A Map has no prototype chain to fall through.
    this.df = new Map(Object.entries(table.df));
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedDetailed(text: string): Promise<EmbeddingDetail> {
    return this.embedSyncDetailed(text);
  }

  /** `log((N + 1) / (df + 1)) + 1` — smoothed, floor 1, so no committed token is zeroed out. */
  private idf(token: string): number {
    const df = this.df.get(token) ?? 0;
    return Math.log((this.documentCount + 1) / (df + 1)) + 1;
  }

  /** The same computation without the promise — what the offline threshold sweep calls. */
  embedSync(text: string): number[] {
    return this.embedSyncDetailed(text).vector;
  }

  /**
   * `embedSync` plus the two numbers it used to throw away.
   *
   * `embedSync` now delegates here, which is deliberate: one computation, so the vector this
   * returns and the vector `embedSync` returns cannot drift apart. `test/unit/embedding-provider.
   * test.ts` pins that they are element-for-element identical and that the model string is the
   * literal it has always been.
   */
  embedSyncDetailed(text: string): { vector: number[]; norm: number; tokens: number } {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);

    const vector = new Array<number>(this.dimensions).fill(0);
    for (const [token, count] of counts) {
      const weight = (1 + Math.log(count)) * this.idf(token) ** this.exponent;
      const digest = createHash("sha256").update(token, "utf8").digest();
      for (let draw = 0; draw < 2; draw++) {
        const offset = draw * 4;
        const index = digest.readUInt32BE(offset) % this.dimensions;
        // One bit of the digest picks the sign, so collisions cancel as often as they add.
        const sign = (digest[offset + 4] as number) & 1 ? 1 : -1;
        vector[index] = (vector[index] as number) + sign * weight;
      }
    }
    const normalized = normalize(vector);
    // The DISTINCT-token count, not the word count: it is the size of the weighted vocabulary the
    // vector actually carries, which is what the overlap arm's substance guard is about. A stub
    // that repeats one rare term four hundred times still has a vocabulary of one.
    return { vector: normalized.vector, norm: normalized.norm, tokens: counts.size };
  }
}

/**
 * The provider this deployment is configured for, or `undefined` when detection is off.
 */
export function createEmbeddingProvider(
  embedding: EmbeddingConfig = defaultConfig.embedding,
): EmbeddingProvider | undefined {
  if (embedding.provider === "disabled") return undefined;
  return new LexicalEmbeddingProvider();
}

/** `[0.1,-0.2,…]` — the text form pgvector parses. Bound as a parameter and cast, never inlined. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Cosine similarity of two already-normalised vectors, clamped to [-1, 1] against float drift. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) dot += (a[i] as number) * (b[i] as number);
  return Math.max(-1, Math.min(1, dot));
}
