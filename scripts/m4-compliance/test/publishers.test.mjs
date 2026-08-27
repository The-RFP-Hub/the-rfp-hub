/**
 * `extractRenderedSlugs` — the slug-extraction half of the M4-2 check (item 8 of the Codex
 * review). It never touches a real browser: it only calls `page.$$eval(selector, fn)`, so a fake
 * `page` that runs `fn` against an in-memory element list is enough to test the selector fallback
 * and the text-parsing rule (slug is the text before the first `:`) without Playwright at all.
 */
import { describe, expect, it } from "vitest";
import { extractRenderedSlugs } from "../checks/publishers.mjs";

/** A fake Playwright `page`: `$$eval(selector, fn)` runs `fn` over whatever `dom[selector]` lists. */
function fakePage(dom) {
  return {
    async $$eval(selector, fn) {
      const elements = dom[selector] ?? [];
      return fn(elements);
    },
  };
}

/** An element exposing just what the real extraction reads: `getAttribute` and `textContent`. */
function el({ attr, text }) {
  return {
    getAttribute: (name) => (name === "data-publisher-slug" ? (attr ?? null) : null),
    textContent: text ?? null,
  };
}

describe("extractRenderedSlugs", () => {
  it("prefers [data-publisher-slug] when present", () => {
    const page = fakePage({
      "[data-publisher-slug]": [el({ attr: "acme" }), el({ attr: "beta-labs" })],
      "article.publisher-card code": [el({ text: "wrong:…" })],
    });
    return extractRenderedSlugs(page).then((result) => {
      expect(result).toEqual({
        renderedSlugs: ["acme", "beta-labs"],
        extractionUsed: "data-publisher-slug",
      });
    });
  });

  it("falls back to article.publisher-card code, parsing the slug before the colon", async () => {
    const page = fakePage({
      "[data-publisher-slug]": [],
      "article.publisher-card code": [el({ text: "acme:…" }), el({ text: "beta-labs:…" })],
    });
    const result = await extractRenderedSlugs(page);
    expect(result).toEqual({
      renderedSlugs: ["acme", "beta-labs"],
      extractionUsed: "article.publisher-card code",
    });
  });

  it("trims whitespace around the slug", async () => {
    const page = fakePage({
      "[data-publisher-slug]": [],
      "article.publisher-card code": [el({ text: "  acme :…" })],
    });
    const result = await extractRenderedSlugs(page);
    expect(result.renderedSlugs).toEqual(["acme"]);
  });

  it("reports 'none' when neither selector matches anything", async () => {
    const page = fakePage({ "[data-publisher-slug]": [], "article.publisher-card code": [] });
    const result = await extractRenderedSlugs(page);
    expect(result).toEqual({ renderedSlugs: [], extractionUsed: "none" });
  });

  it("drops an empty slug produced by a malformed code element", async () => {
    const page = fakePage({
      "[data-publisher-slug]": [],
      "article.publisher-card code": [el({ text: ":…" }), el({ text: "acme:…" })],
    });
    const result = await extractRenderedSlugs(page);
    expect(result.renderedSlugs).toEqual(["acme"]);
  });
});
