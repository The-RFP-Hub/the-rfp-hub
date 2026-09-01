/**
 * `extractRenderedSlugs` — the slug-extraction half of the M4-2 check (item 8 of the Codex
 * review). It never touches a real browser: it only calls `page.$$eval(selector, fn)`, so a fake
 * `page` that runs `fn` against an in-memory element list is enough to test the selector fallback
 * and the text-parsing rule (slug is the text before the first `:`) without Playwright at all.
 *
 * The second `describe` below (`checkPublishers`) exercises the whole check, with `request` and
 * `withPage` mocked, specifically to catch a regression Codex round 2 found: an earlier revision
 * of the `withPage` callback returned only `extractRenderedSlugs`'s result, dropping the captured
 * `requests` array, so `requests.length` on the success path threw — a bug that never surfaced in
 * manual runs because `/publishers` didn't exist in production yet (the check returns early on
 * that 404, before ever reaching the code that crashed).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../m2-compliance/http.mjs", () => ({ request: vi.fn() }));
vi.mock("../browser.mjs", () => ({ withPage: vi.fn() }));

import { request } from "../../m2-compliance/http.mjs";
import { withPage } from "../browser.mjs";
import {
  checkPublishers,
  extractRenderedSlugs,
  publisherPayloadErrors,
} from "../checks/publishers.mjs";
import { Report } from "../report.mjs";

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

/**
 * A fake Playwright `page` for the full `checkPublishers` integration test below.
 *
 * `goto` is called by the real check with the SITE page's URL (`https://.../publishers`), not the
 * API's — the actual `/v1/publishers` request is something the loaded page's OWN client-side code
 * fires as a side effect of rendering, which is exactly what `page.on("request", ...)` exists to
 * observe. `apiRequestUrl` is this fake's stand-in for that side effect: on `goto`, it simulates
 * the page having made that one request, the way a real browser would once the page mounts.
 */
function fakeBrowserPage(dom, apiRequestUrl, { emptyState = false } = {}) {
  const handlers = {};
  return {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    async goto() {
      handlers.request?.({ url: () => apiRequestUrl, headers: () => ({}) });
    },
    async $$eval(selector, fn) {
      return fn(dom[selector] ?? []);
    },
    async evaluate() {
      return emptyState;
    },
  };
}

describe("checkPublishers — the 200 success path with a fake page", () => {
  const SITE = "https://site.example";
  const API = "https://api.example";

  it("does not crash on requests.length, and reports both the slug match and the auth-header check", async () => {
    request.mockImplementation(async (url) => {
      if (url === `${SITE}/publishers`) return { ok: true, status: 200, body: "<html></html>" };
      if (url === `${API}/v1/publishers`) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ items: [{ slug: "acme" }], total: 1 }),
        };
      }
      throw new Error(`unexpected request to ${url}`);
    });

    withPage.mockImplementation(async (_repoRoot, fn) => {
      const page = fakeBrowserPage(
        {
          "[data-publisher-slug]": [],
          "article.publisher-card code": [el({ text: "acme:…" })],
        },
        `${API}/v1/publishers`,
      );
      return fn(page);
    });

    const report = new Report({ siteUrl: SITE, baseUrl: API, node: process.version });
    const ctx = {
      site: SITE,
      api: API,
      repoRoot: "/irrelevant",
      timeoutMs: 5000,
      browser: true,
      skip: new Set(),
    };

    await checkPublishers(report, ctx);

    const json = report.toJSON();
    const checks = json.criteria[0].checks;
    const names = checks.map((c) => c.name);

    // The regression: this whole check used to throw inside the try block (`requests` was
    // `undefined`) and land in the catch — "rendered /publishers page" — instead of ever reaching
    // either check below.
    expect(names).not.toContain("rendered /publishers page");
    expect(checks.find((c) => c.name.startsWith("every API slug"))?.status).toBe("pass");
    expect(
      checks.find(
        (c) => c.name === "the browser's request to /v1/publishers carries no Authorization header",
      )?.status,
    ).toBe("pass");
  });
});

describe("publisherPayloadErrors", () => {
  it("accepts the shape the API promises", () => {
    expect(publisherPayloadErrors({ items: [{ slug: "acme" }], total: 1 })).toEqual([]);
    expect(publisherPayloadErrors({ items: [], total: 0 })).toEqual([]);
  });

  it("rejects the shapes the previous `json.items ?? []` silently accepted as empty", () => {
    // Every one of these produced an empty Set and then compared it against an empty API result,
    // which is how a malformed response passed as "the page matches the API".
    expect(publisherPayloadErrors({})).not.toEqual([]);
    expect(publisherPayloadErrors({ items: null, total: 0 })).not.toEqual([]);
    expect(publisherPayloadErrors({ items: {}, total: 0 })).not.toEqual([]);
    expect(publisherPayloadErrors([])).not.toEqual([]);
  });

  it("rejects a total that disagrees with items, and a repeated slug", () => {
    expect(publisherPayloadErrors({ items: [{ slug: "a" }], total: 7 }).join(" ")).toContain(
      "total is 7",
    );
    expect(
      publisherPayloadErrors({ items: [{ slug: "a" }, { slug: "a" }], total: 2 }).join(" "),
    ).toContain("repeats a slug");
  });

  it("rejects an entry with no slug", () => {
    expect(publisherPayloadErrors({ items: [{ name: "Acme" }], total: 1 }).join(" ")).toContain(
      "slug",
    );
  });
});
