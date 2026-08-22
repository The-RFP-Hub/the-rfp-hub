/**
 * PAGE EXTRACTION, and the soft-404 heuristic.
 *
 * The extractor is regex-based and says so; what these cases pin is that its output is either
 * right or absent, never wrong in a way that would matter — script bodies never leak into the
 * visible text, entities are decoded, and a page that answers 200 for a deleted programme is
 * recognised as the missing page it is. Sites answer 200 for a dead programme far more often than
 * they answer 404, so status alone would mark half the dead links verified.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_CONTENT_CHARS,
  decodeEntities,
  detectSoftNotFound,
  extractPage,
} from "../../src/modules/shared/html-extract.js";

const PAGE = `<!doctype html>
<html><head>
  <title>Ecosystem Grants Round 5 &amp; Beyond | Example Foundation</title>
  <meta property="og:title" content="Ecosystem Grants Round 5">
  <meta name="description" content="Applications close 1 March 2026.">
  <script type="application/ld+json">{"@type":"Event","name":"Round 5"}</script>
  <script>var leaked = "this must never appear in the text";</script>
  <style>.a { color: red }</style>
</head><body>
  <h1>Ecosystem Grants</h1>
  <p>Up to $50,000 per project. ${"Filler sentence about public goods. ".repeat(10)}</p>
  <!-- a comment that is not content -->
</body></html>`;

describe("extractPage", () => {
  it("reads the title, decoding entities and collapsing whitespace", () => {
    expect(extractPage(PAGE).title).toBe("Ecosystem Grants Round 5 & Beyond | Example Foundation");
  });

  it("prefers og:title where a page publishes one", () => {
    const page = extractPage(PAGE);
    expect(page.ogTitle).toBe("Ecosystem Grants Round 5");
    expect(page.description).toBe("Applications close 1 March 2026.");
    expect(page.meta["og:title"]).toBe("Ecosystem Grants Round 5");
  });

  it("parses JSON-LD blocks and skips unparseable ones without throwing", () => {
    expect(extractPage(PAGE).jsonLd).toEqual([{ "@type": "Event", name: "Round 5" }]);
    const broken = '<script type="application/ld+json">{not json</script>';
    expect(extractPage(broken).jsonLd).toEqual([]);
  });

  // Script and style bodies are not visible text. Letting them through would put minified
  // JavaScript into a stored snapshot and into every field-presence test run against it.
  it("keeps script, style and comment bodies out of the visible text", () => {
    const { text } = extractPage(PAGE);
    expect(text).not.toContain("leaked");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("a comment that is not content");
    expect(text).toContain("Up to $50,000 per project.");
  });

  it("honours the text limit", () => {
    expect(extractPage(`<body>${"x".repeat(5000)}</body>`, { textLimit: 100 }).text).toHaveLength(
      100,
    );
  });

  it("survives markup it cannot really parse", () => {
    const page = extractPage("<html><body><p>unclosed <b>bold</body>");
    expect(page.text).toContain("unclosed bold");
    expect(page.title).toBeUndefined();
  });

  it("reads attributes however they are quoted", () => {
    const page = extractPage(`<meta name=description content='single quoted'>`);
    expect(page.meta.description).toBe("single quoted");
  });
});

describe("decodeEntities", () => {
  it("decodes the named and numeric forms that appear in titles", () => {
    expect(decodeEntities("R&amp;D &quot;grants&quot; &#8212; &#x2014;")).toBe('R&D "grants" — —');
  });

  it("leaves an unknown entity alone rather than mangling it", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("detectSoftNotFound", () => {
  it("passes a real page", () => {
    expect(detectSoftNotFound(extractPage(PAGE)).suspected).toBe(false);
  });

  // The heuristic that fired is recorded, because a reviewer should not have to take the verdict
  // on faith.
  it("catches a 200 whose title announces it is gone, and names the reason", () => {
    for (const title of ["404 Not Found", "This page is no longer available", "Page Unavailable"]) {
      const result = detectSoftNotFound(
        extractPage(`<title>${title}</title><body>${"word ".repeat(200)}</body>`),
      );
      expect(result.suspected, title).toBe(true);
      expect(result.heuristic, title).toContain("not-found phrase");
    }
  });

  it("catches an empty shell, and says how little text there was", () => {
    const result = detectSoftNotFound(extractPage("<title>Grants</title><body>Loading…</body>"));
    expect(result.suspected).toBe(true);
    expect(result.heuristic).toContain(String(MIN_CONTENT_CHARS));
  });
});
