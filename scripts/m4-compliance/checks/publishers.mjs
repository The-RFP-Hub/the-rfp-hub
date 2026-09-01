import { request } from "../../m2-compliance/http.mjs";
/**
 * M4-2 — the public `/publishers` page.
 *
 * `GET {api}/v1/publishers` is the source of truth (unauthenticated, ordered by slug — see
 * `organization.repository.ts`). The page is client-fetched, so without `--browser` this check can
 * only prove the route answers 200; WITH `--browser` it renders the page and asserts the set of
 * slugs shown equals the API's, and that the browser's own request to the API carried no
 * `Authorization` header — the page must not smuggle a credential into an otherwise-public listing.
 */
import { withPage } from "../browser.mjs";

/**
 * Extract the set of slugs the rendered `/publishers` page actually shows, and how.
 *
 * Two selectors, tried in order of preference:
 *
 *   1. `[data-publisher-slug]` — the robust, purpose-built attribute. It DOES exist in the markup
 *      (`packages/frontend/src/app/publishers/page.tsx`'s `PublisherCard`, on the `<article
 *      className="card publisher-card" data-publisher-slug={publisher.slug}>` element itself) —
 *      added by the frontend stream specifically because an earlier revision of this check's WARN
 *      named the attribute explicitly when extraction found nothing. This is now the path that
 *      actually runs; a prior revision of this comment still described it as aspirational, which
 *      it no longer is.
 *   2. `article.publisher-card code` — the fallback, kept for robustness against a markup change
 *      that ever drops the attribute again: each card also carries `<code>{slug}:…</code>` as "the
 *      namespace every one of this organization's ids is prefixed with" (the component's own
 *      comment). The slug is the text before the first `:` — the trailing `:…` is decoration, not
 *      part of the identifier, and a Standard slug cannot itself contain a colon (ids are
 *      `<namespace>:<local>`, so a colon inside the namespace half would make an id unparseable).
 *
 * Returns `{ renderedSlugs, extractionUsed }`, where `extractionUsed` is `"data-publisher-slug"`,
 * `"article.publisher-card code"`, or `"none"` when neither selector matched anything — the caller
 * treats that last case as "cannot verify", never as "the rendered set is empty".
 */
export async function extractRenderedSlugs(page) {
  const viaAttribute = await page.$$eval("[data-publisher-slug]", (elements) =>
    elements.map((el) => el.getAttribute("data-publisher-slug")),
  );
  if (viaAttribute.length > 0) {
    return { renderedSlugs: viaAttribute, extractionUsed: "data-publisher-slug" };
  }

  const viaCode = await page.$$eval("article.publisher-card code", (elements) =>
    elements.map((el) => (el.textContent ?? "").split(":")[0].trim()),
  );
  if (viaCode.length > 0) {
    return {
      renderedSlugs: viaCode.filter((slug) => slug.length > 0),
      extractionUsed: "article.publisher-card code",
    };
  }

  return { renderedSlugs: [], extractionUsed: "none" };
}

export async function checkPublishers(report, ctx) {
  const c = report.criterion(
    "M4-2",
    "Public /publishers page",
    "The page answers 200, and — rendered — shows exactly the slugs GET /v1/publishers returns, requesting them without an Authorization header.",
  );

  if (ctx.skip.has("publishers")) {
    c.skip("publishers", "--skip publishers");
    return c.finish();
  }

  const pageUrl = `${ctx.site}/publishers`;
  const pageRes = await request(pageUrl, { timeoutMs: ctx.timeoutMs });
  c.expect(
    pageRes.ok && pageRes.status === 200,
    `GET ${pageUrl} → 200`,
    `HTTP ${pageRes.status}`,
    pageRes.ok ? `HTTP ${pageRes.status}` : `transport: ${pageRes.error}`,
  );
  if (!pageRes.ok || pageRes.status !== 200) return c.finish();

  const apiUrl = `${ctx.api}/v1/publishers`;
  const apiRes = await request(apiUrl, { timeoutMs: ctx.timeoutMs });
  if (!apiRes.ok || apiRes.status !== 200) {
    c.fail(
      `GET ${apiUrl} → 200 (source of truth)`,
      apiRes.ok ? `HTTP ${apiRes.status}` : `transport: ${apiRes.error}`,
    );
    return c.finish();
  }
  let apiSlugs;
  try {
    const json = JSON.parse(apiRes.body);
    apiSlugs = new Set((json.items ?? []).map((item) => item.slug));
  } catch (err) {
    c.fail(`GET ${apiUrl} → 200 (source of truth)`, `response is not valid JSON: ${err.message}`);
    return c.finish();
  }
  c.info(
    "publishers reported by the API",
    `${apiSlugs.size} slug(s): ${[...apiSlugs].join(", ") || "(none)"}`,
  );

  if (!ctx.browser) {
    c.unmet(
      "rendered slugs equal the API's",
      "needs --browser — the page is client-fetched, so a plain GET of the HTML cannot see the rendered list",
    );
    c.unmet(
      "the browser's request to /v1/publishers carries no Authorization header",
      "needs --browser",
    );
    return c.finish();
  }

  try {
    const { renderedSlugs, extractionUsed, requests } = await withPage(
      ctx.repoRoot,
      async (page) => {
        const seen = [];
        page.on("request", (req) => {
          if (req.url().includes("/v1/publishers")) {
            seen.push({ url: req.url(), headers: req.headers() });
          }
        });
        await page.goto(pageUrl, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
        const extracted = await extractRenderedSlugs(page);
        // `seen` (the captured /v1/publishers requests) has to come back too — an earlier
        // revision of this callback returned only `extractRenderedSlugs`'s result, so `requests`
        // at the call site was `undefined` and `requests.length` below threw on every SUCCESSFUL
        // extraction. It went unnoticed only because /publishers didn't exist yet in production
        // (the check returns early on the 404 before ever reaching this code).
        return { ...extracted, requests: seen };
      },
    );

    if (extractionUsed === "none") {
      // Neither selector below matched anything: this is not "the set happens to be empty" (an
      // empty verified-publisher set still renders an EmptyState, a different element entirely),
      // it is "this checker cannot find the publisher cards at all". Report it by name rather than
      // silently comparing an empty extracted set against the API's and calling every slug
      // "missing" — that would be a wrong diagnosis, not a right one.
      c.warn(
        "every API slug appears in the rendered page, and only those slugs",
        `could not extract any rendered slug (looked for "[data-publisher-slug]", then "article.publisher-card code") — both exist in packages/frontend/src/app/publishers/page.tsx today, so this means the markup has since been renamed or removed; check PublisherCard directly`,
      );
    } else {
      const rendered = new Set(renderedSlugs);
      const missing = [...apiSlugs].filter((slug) => !rendered.has(slug));
      const extra = [...rendered].filter((slug) => !apiSlugs.has(slug));
      c.expect(
        missing.length === 0 && extra.length === 0,
        `every API slug appears in the rendered page, and only those slugs (via ${extractionUsed})`,
        `${apiSlugs.size} slug(s) match exactly`,
        [
          missing.length > 0 ? `missing from the rendered page: ${missing.join(", ")}` : null,
          extra.length > 0 ? `rendered but not in GET /v1/publishers: ${extra.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; "),
      );
    }

    if (requests.length === 0) {
      c.warn(
        "the browser's request to /v1/publishers carries no Authorization header",
        "no request to a URL containing /v1/publishers was observed — the page may fetch through a proxy path; cannot verify",
      );
    } else {
      const withAuth = requests.filter((r) => r.headers.authorization);
      c.expect(
        withAuth.length === 0,
        "the browser's request to /v1/publishers carries no Authorization header",
        `${requests.length} request(s) observed, none authorized`,
        `${withAuth.length} request(s) to /v1/publishers carried an Authorization header — this route must stay anonymous`,
      );
    }
  } catch (err) {
    c.fail("rendered /publishers page", `browser check failed: ${err.message}`);
  }

  return c.finish();
}
