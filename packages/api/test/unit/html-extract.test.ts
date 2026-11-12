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
import { extractPageBounded } from "../../src/modules/shared/html-extract-bounded.js";
import {
  MIN_CONTENT_CHARS,
  decodeEntities,
  detectBotChallenge,
  detectSoftNotFound,
  extractPage,
} from "../../src/modules/shared/html-extract.js";
import { extractPageWithRegexes } from "../helpers/html-extract-regex-reference.js";
import { sourcePage } from "../helpers/verify-transport.js";

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

describe("detectBotChallenge", () => {
  it("recognises common challenge copy without classifying an ordinary page", () => {
    const challenge = extractPage(
      "<title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body>",
    );
    expect(detectBotChallenge(challenge)).toMatchObject({
      suspected: true,
      heuristic: expect.stringContaining("automated-access challenge"),
    });
    expect(detectBotChallenge(extractPage(PAGE)).suspected).toBe(false);
  });
});

/*
 * THE SCANNER FINDS WHAT THE REGEXES FOUND.
 *
 * `extractPage` used to be a chain of backtracking regexes and is now a linear scanner
 * (`html-extract.ts`, "THE SCANNER"). The rewrite is a fix for its running time and must change
 * nothing else: same title, same meta, same JSON-LD, same visible text. The old expressions are
 * kept as an oracle (`test/helpers/html-extract-regex-reference.ts`) and both are run over every
 * page this suite and the verification suites use, over the edge cases the scanner reasons about
 * one by one, and over generated tag soup built from exactly those edges.
 */
const FIXTURES: Record<string, string> = {
  "this suite's page": PAGE,
  "a verification source page": sourcePage({
    title: "Superchain Builders Fund",
    ogTitle: "Superchain Builders Fund | Example Foundation",
    deadline: "March 1, 2099",
    amount: "50,000",
    organization: "Example Foundation",
  }),
  "a source page without og:title": sourcePage({ title: "Superchain Builders Fund" }),
  "a soft 404":
    "<!doctype html><html><head><title>Page not found</title></head><body>Gone.</body></html>",
  "a challenge page":
    "<!doctype html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>",
  "the fetcher's page":
    "<!doctype html><html><head><title>A programme</title></head><body>Hi.</body></html>",
  "unclosed markup": "<html><body><p>unclosed <b>bold</body>",
  "single-quoted meta": `<meta name=description content='single quoted'>`,
  "broken JSON-LD": '<script type="application/ld+json">{not json</script>',
  // The edges the scanner handles explicitly.
  "an opener that is a longer word": "<scripts>a</scripts><titles>b</titles><metadata x>c",
  "case and whitespace in closers": "<SCRIPT>x</script \n><Title>T</TITLE\t>y<StYlE>z</style>w",
  "a closer with an attribute": "<script>a</script x>still script</script>after",
  "an unclosed comment after a closed one": "<!-- a -->b<!-- c <script>d</script>",
  "the shortest non-comment": "<!-->x<!--->y-->z",
  "a script opener with no >": "<p>a</p><script src=x",
  "JSON-LD in a non-JSON-LD script's body":
    '<script>var s = \'<script type="application/ld+json">{"a":1}</script>\';</script>',
  "several openers sharing one >":
    '<script <script type="application/ld+json" <script x>{"b":2}</script>',
  "JSON-LD type in mixed case": "<script TYPE = 'Application/LD+JSON'>{\"c\":3}</script>",
  "non-ASCII letters that look like ASCII": "<ſcript>x</ſcript><tİtle>y</tİtle><title>İ</title>",
  "a Unicode space inside a closer": "<title>a</title >b<title>c</title >",
  "a script inside a comment": "<!-- <script>x</script> -->visible",
  "a comment inside a script": "<script><!-- x --></script>visible",
};

const ATOMS = [
  "<",
  ">",
  "<!--",
  "-->",
  "--",
  "<!-->",
  "<script",
  "<SCRIPT",
  "<scripts",
  "</script",
  "</script>",
  "</SCRIPT >",
  "</script\n>",
  "</script x>",
  "<style",
  "</style>",
  "<noscript",
  "</noscript>",
  "<title",
  "<TITLE>",
  "</title>",
  "</title >",
  "<meta",
  "<META",
  "<metadata",
  " name=description",
  " property='og:title'",
  ' content="x &amp; y"',
  " content=z",
  ' type="application/ld+json"',
  " type=application/ld+json",
  " TYPE = 'application/LD+JSON'",
  '{"a":1}',
  "{bad",
  " ",
  "\n",
  " ",
  " ",
  "text",
  "&amp;",
  "&#39;",
  "&#x2014;",
  "x",
  "_",
  "1",
  "İ",
  "ſcript",
  '<script type="application/ld+json">',
  '<script x type=application/ld+json y>{"b":2}</script>',
  '{"c":3}',
  "<meta name=a content=b>",
  "<title>T</title>",
  "<p>",
  "</p>",
  "=",
  '"',
  "'",
  "<script>",
  "<title>",
  "<meta >",
];

/** A seeded generator, so a failure names a case that can be reproduced. */
function soup(seed: number, count: number): string[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const pages: string[] = [];
  for (let i = 0; i < count; i++) {
    let html = "";
    const atoms = 1 + Math.floor(next() * 14);
    for (let k = 0; k < atoms; k++) html += ATOMS[Math.floor(next() * ATOMS.length)];
    pages.push(html);
  }
  return pages;
}

describe("extractPage, compared with the regex extractor it replaced", () => {
  for (const [name, html] of Object.entries(FIXTURES)) {
    it(`agrees on ${name}`, () => {
      expect(extractPage(html)).toEqual(extractPageWithRegexes(html));
    });
  }

  it("agrees on 20 000 pages of generated tag soup", () => {
    const pages = soup(12345, 20_000);
    const disagreements = pages.filter(
      (html) => JSON.stringify(extractPage(html)) !== JSON.stringify(extractPageWithRegexes(html)),
    );
    expect(disagreements.slice(0, 5)).toEqual([]);
    // The soup is only worth something if it reaches every output.
    expect(pages.filter((html) => extractPageWithRegexes(html).title).length).toBeGreaterThan(500);
    expect(
      pages.filter((html) => extractPageWithRegexes(html).jsonLd.length).length,
    ).toBeGreaterThan(500);
    expect(
      pages.filter((html) => Object.keys(extractPageWithRegexes(html).meta).length).length,
    ).toBeGreaterThan(500);
  });

  it("honours the text limit the same way", () => {
    const html = `<title>t</title><body>${"word ".repeat(400)}</body>`;
    expect(extractPage(html, { textLimit: 77 })).toEqual(
      extractPageWithRegexes(html, { textLimit: 77 }),
    );
  });
});

/*
 * HOSTILE PAGES, at the fetcher's own byte cap.
 *
 * Each shape opens a construct and never closes it, which is what made the regex extractor
 * quadratic: measured at ~20 s for 256 KiB of `<!--` and ~18 s for 256 KiB of `<meta ` before the
 * rewrite, four times as long for every doubling. At 2 MiB (`VERIFY_MAX_BYTES`) each must now be
 * read in well under a quarter of a second on a developer machine. Shared CI runners are slower
 * and noisier (the same shapes measured 190-290 ms there), so under `CI` the ceiling is 1 s: still
 * twenty times below what the regexes took at an eighth of the size.
 *
 * A wall-clock ceiling alone depends on the machine, so each shape is also read at a quarter of
 * the size: four times the page must take about four times as long (linear), not sixteen times
 * (quadratic). That ratio holds on any machine and is what catches the quadratic behaviour coming
 * back. A single doubling (2× against 4×) left too little room: a CI runner measured 3.3× on a
 * linear shape. Times are the best of several runs after a warm-up, so a noisy neighbour does not
 * fail the suite.
 */
const MiB = 1024 * 1024;
const fill = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

const CEILING_MS = process.env.CI ? 1_000 : 250;
/** For 4× the bytes, linear is ~4× the time and quadratic ~16×; 8× sits between them. */
const MAX_SCALE_RATIO = 8;
/** Timer and GC jitter on runs of a few milliseconds, so tiny times do not decide the ratio. */
const RATIO_SLACK_MS = 5;

const HOSTILE: Record<string, (bytes: number) => string> = {
  "`<!--` never closed": (bytes) => fill("<!--", bytes),
  "`<meta ` with no `>`": (bytes) => fill("<meta ", bytes),
  "`<` with no `>`": (bytes) => fill("<", bytes),
  "`<script>` never closed": (bytes) => fill("<script>", bytes),
  "`<script ` with no `>`": (bytes) => fill("<script ", bytes),
  "`<script ` openers sharing one `>`": (bytes) => `${fill("<script ", bytes - 1)}>`,
  "`<style>` never closed": (bytes) => fill("<style>", bytes),
  "`<noscript>` never closed": (bytes) => fill("<noscript>", bytes),
  "`<title>` never closed": (bytes) => fill("<title>", bytes),
  "a JSON-LD opener never closed": (bytes) => fill('<script type="application/ld+json">', bytes),
  'one `<meta` full of `content="`': (bytes) => `<meta ${fill('content="', bytes - 7)}>`,
};

function bestOf(html: string, runs: number): number {
  extractPage(html); // warm-up: the first run pays for compilation, not for the page
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < runs; attempt++) {
    const start = performance.now();
    extractPage(html);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("extractPage on hostile pages", () => {
  for (const [name, make] of Object.entries(HOSTILE)) {
    it(`reads 2 MiB of ${name} in under ${CEILING_MS} ms, and four times the page takes about four times as long`, () => {
      const quarter = bestOf(make(MiB / 2), 5);
      const full = bestOf(make(2 * MiB), 5);
      expect(full).toBeLessThan(CEILING_MS);
      expect(full).toBeLessThan(MAX_SCALE_RATIO * quarter + RATIO_SLACK_MS);
    }, 30_000);
  }
});

describe("extractPageBounded", () => {
  it("returns what extractPage returns, read in a worker", async () => {
    const result = await extractPageBounded(PAGE, { timeoutMs: 30_000, textLimit: 100 });
    expect(result).toEqual({ ok: true, page: extractPage(PAGE, { textLimit: 100 }) });
  });

  it("reports an extraction that misses its deadline as interrupted, instead of waiting for it", async () => {
    // One millisecond is less than a worker takes to start, so the deadline always wins here.
    const start = performance.now();
    const result = await extractPageBounded(fill("<p>a</p>", 2 * MiB), { timeoutMs: 1 });
    expect(result).toEqual({
      ok: false,
      kind: "interrupted",
      reason: expect.stringMatching(/^extraction_interrupted: .*within 1 ms/),
    });
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
