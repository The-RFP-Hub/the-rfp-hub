/**
 * THE EMBEDDING TEXT.
 *
 * `content_hash` decides whether a stored embedding is still current, so any non-determinism here
 * makes every backfill re-embed the whole table — and pay for it. The cases below pin the three
 * ways that happens: whitespace that varies with whoever pasted the description, a truncation that
 * depends on locale, and a hash that ignores which model produced the vector.
 *
 * And one rule that is about this repository rather than about embeddings: NO LITERAL NUL BYTE.
 * `scripts/check-neutral.mjs` SKIPS a tracked file containing one, so a NUL delimiter would make
 * this module invisible to the repository's own source-neutrality scan and to `git diff`.
 */
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_LIMIT,
  collapseWhitespace,
  contentHash,
  embeddingText,
} from "../../src/modules/shared/embedding-text.js";

const record = {
  title: "Ecosystem Grants Round 5",
  summary: "Funding for public goods on Ethereum.",
  description: "A much longer body that is not used while a summary exists.",
  fundingType: "grant",
  ecosystems: ["ethereum", "optimism"],
  categories: ["public-goods"],
  operatingOrganizations: [{ name: "Example Foundation" }, { name: "Second Org" }],
};

describe("embeddingText", () => {
  it("composes title, body, orgs, ecosystems, categories and funding type", () => {
    expect(embeddingText(record)).toBe(
      [
        "Ecosystem Grants Round 5",
        "Funding for public goods on Ethereum.",
        "Example Foundation, Second Org",
        "ethereum, optimism",
        "public-goods",
        "grant",
      ].join("\n\n"),
    );
  });

  it("is deterministic across calls", () => {
    expect(embeddingText(record)).toBe(embeddingText({ ...record }));
  });

  // The same record pasted with CRLF endings, or with a stray tab, is the same record.
  it("collapses every kind of whitespace, so line endings cannot change the vector", () => {
    const messy = { ...record, title: " Ecosystem\r\n Grants\tRound  5 " };
    expect(embeddingText(messy)).toBe(embeddingText(record));
    expect(collapseWhitespace("a \n\t b ")).toBe("a b");
  });

  it("falls back to the description when there is no summary, truncated", () => {
    const long = { ...record, summary: null, description: "word ".repeat(2000) };
    const text = embeddingText(long);
    const body = text.split("\n\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    // Truncation lands on a word boundary rather than mid-token.
    expect(body.endsWith("word")).toBe(true);
  });

  it("drops empty parts rather than emitting empty delimiters", () => {
    expect(embeddingText({ title: "Only a title" })).toBe("Only a title");
    expect(embeddingText({})).toBe("");
  });

  it("preserves organization order, which is semantic in the Standard", () => {
    const reversed = {
      ...record,
      operatingOrganizations: [{ name: "Second Org" }, { name: "Example Foundation" }],
    };
    expect(embeddingText(reversed)).not.toBe(embeddingText(record));
  });

  // The repository-level rule, asserted rather than assumed.
  it("never emits a NUL byte", () => {
    expect(embeddingText(record)).not.toContain("\u0000");
  });
});

describe("contentHash", () => {
  it("is stable for the same text, model and provider", () => {
    expect(contentHash("text", "m", "p")).toBe(contentHash("text", "m", "p"));
    expect(contentHash("text", "m", "p")).toMatch(/^[0-9a-f]{64}$/);
  });

  // Two models produce vectors in different spaces. A hash over the text alone would leave a row
  // that survived a provider switch looking current, with a vector nothing else is comparable to.
  it("changes when the model or the provider changes", () => {
    const base = contentHash("text", "model-a", "openai");
    expect(contentHash("text", "model-b", "openai")).not.toBe(base);
    expect(contentHash("text", "model-a", "deterministic")).not.toBe(base);
  });

  // Field-boundary collision: without a separator, ("ab","c") and ("a","bc") would hash alike.
  it("separates its inputs unambiguously", () => {
    expect(contentHash("a", "b", "c")).not.toBe(contentHash("a\nb", "", "c"));
  });
});
