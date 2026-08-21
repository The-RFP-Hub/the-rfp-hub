/**
 * The embedding providers, behind one interface — because the alternative is dedupe tests that do
 * not run.
 *
 * Duplicate detection needs a vector for a piece of text. The real answer is a hosted model, which
 * needs a credential CI does not have and must not have. Gating the dedupe suites on that key means
 * the merge path, the pair hygiene and the leak rule are exercised by nobody, on every commit. So
 * the provider is injectable and there are three settings:
 *
 *   `openai`         `text-embedding-3-small`, 1536 dimensions, over plain `fetch`. No SDK: the API
 *                    takes no vendor dependency, and this is one POST.
 *   `deterministic`  A hashed token bag projected to the same 1536 dimensions. NOT a semantic
 *                    model, and never a silent fallback (see `readEmbeddingProvider`) — it exists so
 *                    the dedupe suites are mandatory in CI, and so the threshold sweep has a
 *                    reproducible space to sweep.
 *   `disabled`       No provider at all. A submission still succeeds; it reports
 *                    `duplicateCheck: "disabled"` and the backfill job picks it up if the setting
 *                    changes.
 *
 * THE THRESHOLD IS A PROPERTY OF THE SPACE, NOT A CONSTANT. A cosine of 0.8 means something
 * different in a 1536-dimension learned space and in a hashed bag of words, so the default is
 * per-provider (`DEFAULT_SIMILARITY_THRESHOLD` in config.ts) and the operating point is settled by
 * `scripts/dedupe-threshold-report.ts` against the committed corpus.
 */
import { createHash } from "node:crypto";
import { type EmbeddingConfig, config as defaultConfig } from "../../../config.js";

/** Every stored vector is this wide — `opportunity_embeddings.embedding` is `vector(1536)`. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  /**
   * Stored on the embedding row and hashed into `content_hash`.
   *
   * Two providers' vectors are not in comparable spaces, so a row that survived a provider switch
   * must not look current. The id is what makes that detectable.
   */
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** One vector, L2-normalised, `dimensions` long. Rejects rather than returns a wrong width. */
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
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
 * a ranking decision for comparing DIFFERENT records, and this is building a vector, where the
 * common words carry real signal about what kind of programme it is.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 1);
}

/**
 * The deterministic, offline provider: signed feature hashing over a sub-linear term-frequency bag.
 *
 * Each token is hashed to TWO (index, sign) pairs rather than one. A single hash puts every
 * collision straight into one coordinate with a fixed sign, so two unrelated documents that happen
 * to collide on a frequent term get a similarity floor they did not earn. Two independent draws
 * halve the variance of the estimate for the same cost, which is the standard reason to do it.
 *
 * `1 + log(tf)` rather than raw counts: a word repeated forty times in a long description is not
 * forty times as much evidence about which programme this is, and raw counts let one boilerplate
 * paragraph dominate the vector.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = "deterministic";
  readonly model = "hashed-token-bag-v1";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  /** The same computation without the promise — what the offline threshold sweep calls. */
  embedSync(text: string): number[] {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);

    const vector = new Array<number>(this.dimensions).fill(0);
    for (const [token, count] of counts) {
      const weight = 1 + Math.log(count);
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

/** The hosted model, over `fetch`. Everything vendor-specific about the API is in this class. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly endpoint = "https://api.openai.com/v1/embeddings",
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: text, model: this.model, dimensions: this.dimensions }),
      signal,
    });
    if (!response.ok) {
      // The body may carry the provider's own explanation; the status is what a reader acts on.
      throw new Error(`embedding request failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dimensions) {
      throw new Error(
        `embedding response was not ${this.dimensions} numbers (got ${
          Array.isArray(vector) ? vector.length : typeof vector
        })`,
      );
    }
    return vector as number[];
  }
}

/**
 * The provider this deployment is configured for, or `undefined` when detection is off.
 *
 * `openai` without a key resolves to `undefined` rather than throwing: a deployment that loses its
 * credential should keep accepting submissions and report `duplicateCheck: "disabled"`, not refuse
 * to start.
 */
export function createEmbeddingProvider(
  embedding: EmbeddingConfig = defaultConfig.embedding,
): EmbeddingProvider | undefined {
  if (embedding.provider === "deterministic") return new DeterministicEmbeddingProvider();
  if (embedding.provider === "openai" && embedding.apiKey !== undefined) {
    return new OpenAIEmbeddingProvider(embedding.model, embedding.apiKey);
  }
  return undefined;
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
