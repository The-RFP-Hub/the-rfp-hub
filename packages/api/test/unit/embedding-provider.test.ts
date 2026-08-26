/**
 * THE PROOF THAT ADDING THE SCALARS CHANGED NO VECTOR.
 *
 * `norm` and `tokenCount` arrived on the embedding row by returning two numbers `embedSync` was
 * already computing and discarding. The whole migration story depends on that being literally true:
 * if the vector moved by one ULP, every `content_hash` moves, the backfill re-embeds the entire
 * table, and a change advertised as "no re-embed occurs" is a lie in the changeset.
 *
 * So this file pins the parts that must not move — the model string as a literal, `embedSync`'s
 * output element-for-element against `embedSyncDetailed`'s — and the parts that are new.
 */
import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  LexicalEmbeddingProvider,
  tokenize,
} from "../../src/modules/services/dedupe/embedding-provider.js";

const SAMPLE =
  "The Optimism Foundation Retro Funding round 8 supports open-source developer tooling " +
  "across the Superchain, with milestones, a deadline of 30 September and rewards paid in OP.";

describe("LexicalEmbeddingProvider identity", () => {
  /**
   * THE MODEL STRING IS THE MIGRATION CONTRACT. It is a digest of the frozen idf table and the
   * exponent, it is hashed into every `content_hash`, and a change to it re-embeds the whole table.
   * Asserted as a LITERAL, not recomputed: recomputing it here would reproduce whatever the code
   * does today and pin nothing at all.
   */
  it("has not moved", () => {
    const provider = new LexicalEmbeddingProvider();
    expect(provider.id).toBe("lexical");
    expect(provider.model).toBe("tfidf-hashed-v1+5561ec0f11de");
    expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it("declares that it supplies a norm", () => {
    expect(new LexicalEmbeddingProvider().suppliesNorm).toBe(true);
  });
});

describe("embedSyncDetailed", () => {
  const provider = new LexicalEmbeddingProvider();

  it("returns exactly the vector embedSync returns", () => {
    const plain = provider.embedSync(SAMPLE);
    const detailed = provider.embedSyncDetailed(SAMPLE);
    expect(detailed.vector).toEqual(plain);
    expect(detailed.vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("agrees with the async surface", async () => {
    const detailed = provider.embedSyncDetailed(SAMPLE);
    await expect(provider.embed(SAMPLE)).resolves.toEqual(detailed.vector);
    await expect(provider.embedDetailed(SAMPLE)).resolves.toEqual(detailed);
  });

  /**
   * `norm` is the L2 norm of the vector BEFORE normalisation — the magnitude the stored unit vector
   * threw away. Checked by reconstruction: multiplying the returned unit vector by the returned
   * norm must give back a vector of that magnitude, which is the property the overlap arm relies on.
   */
  it("reports the pre-normalisation L2 norm", () => {
    const { vector, norm } = provider.embedSyncDetailed(SAMPLE);
    expect(norm).toBeGreaterThan(0);
    const unitLength = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(unitLength).toBeCloseTo(1, 10);
    const restored = Math.sqrt(
      vector.reduce((sum, value) => sum + (value * norm) ** 2, 0),
    );
    expect(restored).toBeCloseTo(norm, 6);
  });

  /**
   * A LONGER document has a LARGER pre-normalisation norm. This is the entire basis of the overlap
   * arm — cosine cannot see it, because normalisation erased it — so it is asserted rather than
   * assumed.
   */
  it("gives a longer document a larger norm", () => {
    const short = provider.embedSyncDetailed(SAMPLE);
    const long = provider.embedSyncDetailed(`${SAMPLE} ${SAMPLE.split(" ").reverse().join(" ")}`);
    expect(long.norm).toBeGreaterThan(short.norm);
  });

  /**
   * DISTINCT tokens, not words. A stub that repeats one rare term four hundred times still has a
   * vocabulary of one, and the substance guard exists to refuse exactly that.
   */
  it("counts DISTINCT tokens", () => {
    expect(provider.embedSyncDetailed(SAMPLE).tokens).toBe(new Set(tokenize(SAMPLE)).size);
    expect(provider.embedSyncDetailed("grants grants grants grants").tokens).toBe(1);
  });

  it("reports a zero norm for text with no tokens at all", () => {
    const empty = provider.embedSyncDetailed("");
    expect(empty.norm).toBe(0);
    expect(empty.tokens).toBe(0);
  });
});
