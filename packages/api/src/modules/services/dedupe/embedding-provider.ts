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
  /** One vector, L2-normalised, `dimensions` long. Rejects rather than returns a wrong width. */
  embed(text: string): Promise<number[]>;
}

/** The shape `idf-table.json` commits — kept structural so tests can hand in synthetic tables. */
export interface IdfTable {
  documentCount: number;
  df: Record<string, number>;
}

/** L2-normalise in place and return. A zero vector stays zero — there is nothing to point at. */
function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / norm;
  return vector;
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
  readonly model = "tfidf-hashed-v1";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  private readonly exponent: number;
  private readonly documentCount: number;
  private readonly df: Record<string, number>;

  constructor(options: { idfExponent?: number; table?: IdfTable } = {}) {
    this.exponent = options.idfExponent ?? IDF_EXPONENT;
    const table = options.table ?? (committedIdfTable as IdfTable);
    this.documentCount = table.documentCount;
    this.df = table.df;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  /** `log((N + 1) / (df + 1)) + 1` — smoothed, floor 1, so no committed token is zeroed out. */
  private idf(token: string): number {
    const df = this.df[token] ?? 0;
    return Math.log((this.documentCount + 1) / (df + 1)) + 1;
  }

  /** The same computation without the promise — what the offline threshold sweep calls. */
  embedSync(text: string): number[] {
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
    return normalize(vector);
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
