import { request } from "../../m2-compliance/http.mjs";
/**
 * M4-2 — the public `/publishers` page.
 *
 * `GET {api}/v1/publishers` is the source of truth (unauthenticated, ordered by slug — see
 * `organization.repository.ts`). The page is client-fetched, so without `--browser` this check can
 * only prove the route answers 200; WITH `--browser` it renders the page and asserts the set of
 * slugs shown equals the API's, and that the browser's own request to the API carried no
 * `Authorization` header — the page must not smuggle a credential into an otherwise-public listing.
 *
 * EVERY UNPROVEN CASE IS A FAILURE, NOT A WARNING. Not being able to find the cards, not observing
 * the browser's request, and a response whose shape this checker does not recognize were all
 * warnings, and warnings were green — so with production answering `{"items":[],"total":0}` the
 * criterion could pass having established nothing at all. An empty listing has its own evidence:
 * the page renders the empty state, and that is what is asserted.
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

/** The response shape this criterion is entitled to assume, checked rather than assumed. */
export function publisherPayloadErrors(json) {
  const errors = [];
  if (!json || typeof json !== "object" || Array.isArray(json))
    return ["body is not a JSON object"];
  if (!Array.isArray(json.items)) errors.push("items is not an array");
  if (!Number.isInteger(json.total))
    errors.push(`total is not an integer (${JSON.stringify(json.total)})`);
  if (Array.isArray(json.items)) {
    const slugs = json.items.map((item) => item?.slug);
    if (slugs.some((slug) => typeof slug !== "string" || slug.length === 0)) {
      errors.push("an items[] entry has no string slug");
    }
    if (new Set(slugs).size !== slugs.length) errors.push("items[] repeats a slug");
    if (Number.isInteger(json.total) && json.total !== json.items.length) {
      errors.push(`total is ${json.total} but items has ${json.items.length} entries`);
    }
  }
  return errors;
}

export async function checkPublishers(report, ctx) {
  const c = report.criterion(
    "M4-2",
    "Public /publishers page",
    "The page answers 200, the API's response has the shape it promises, and — rendered — the page shows exactly those slugs (or the empty state when there are none), requesting them without an Authorization header.",
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
  let json;
  try {
    json = JSON.parse(apiRes.body);
  } catch (err) {
    c.fail(`GET ${apiUrl} → 200 (source of truth)`, `response is not valid JSON: ${err.message}`);
    return c.finish();
  }
  const shapeErrors = publisherPayloadErrors(json);
  c.expect(
    shapeErrors.length === 0,
    `${apiUrl} answers { items: [...], total: <count> }`,
    `${json.total} publisher(s)`,
    shapeErrors.join("; "),
  );
  if (shapeErrors.length > 0) return c.finish();

  const apiSlugs = new Set(json.items.map((item) => item.slug));
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
    const { renderedSlugs, extractionUsed, requests, emptyState } = await withPage(
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
        // `EmptyState` in packages/frontend/src/components/states.tsx renders `.state.empty`.
        const empty = await page.evaluate(() => document.querySelector(".state.empty") !== null);
        return { ...extracted, requests: seen, emptyState: empty };
      },
    );

    if (apiSlugs.size === 0) {
      c.expect(
        emptyState && renderedSlugs.length === 0,
        "with no verified publishers, the page renders the empty state",
        "the empty state is on screen and no card is rendered",
        emptyState
          ? `the empty state is present but ${renderedSlugs.length} card(s) are rendered too`
          : "no .state.empty element — an empty listing must SAY it is empty, not render a blank page",
      );
    } else if (extractionUsed === "none") {
      // Not "the set happens to be empty" — the API says there ARE publishers, so this is "the
      // cards cannot be found at all", which establishes nothing and must not be green.
      c.fail(
        "every API slug appears in the rendered page, and only those slugs",
        `could not extract any rendered slug (looked for "[data-publisher-slug]", then "article.publisher-card code") while ${apiSlugs.size} publisher(s) are expected — the markup has been renamed or removed; check PublisherCard in packages/frontend/src/app/publishers/page.tsx`,
      );
    } else {
      const rendered = new Set(renderedSlugs);
      const missing = [...apiSlugs].filter((slug) => !rendered.has(slug));
      const extra = [...rendered].filter((slug) => !apiSlugs.has(slug));
      c.expect(
        missing.length === 0 && extra.length === 0 && rendered.size === renderedSlugs.length,
        `every API slug appears in the rendered page, and only those slugs (via ${extractionUsed})`,
        `${apiSlugs.size} slug(s) match exactly`,
        [
          missing.length > 0 ? `missing from the rendered page: ${missing.join(", ")}` : null,
          extra.length > 0 ? `rendered but not in GET /v1/publishers: ${extra.join(", ")}` : null,
          rendered.size !== renderedSlugs.length ? "a slug is rendered more than once" : null,
        ]
          .filter(Boolean)
          .join("; "),
      );
    }

    if (requests.length === 0) {
      c.fail(
        "the browser's request to /v1/publishers carries no Authorization header",
        "no request to a URL containing /v1/publishers was observed, so anonymity was not established — if the page fetches through a proxy path, this check needs to learn that path",
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
