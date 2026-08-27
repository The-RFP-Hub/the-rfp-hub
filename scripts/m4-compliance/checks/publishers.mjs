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
    c.warn(
      "rendered slugs equal the API's",
      "needs --browser — the page is client-fetched, so a plain GET of the HTML cannot see the rendered list",
    );
    c.warn(
      "the browser's request to /v1/publishers carries no Authorization header",
      "needs --browser",
    );
    return c.finish();
  }

  try {
    const { renderedSlugs, requests } = await withPage(ctx.repoRoot, async (page) => {
      const seen = [];
      page.on("request", (req) => {
        if (req.url().includes("/v1/publishers")) {
          seen.push({ url: req.url(), headers: req.headers() });
        }
      });
      await page.goto(pageUrl, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      // Slugs are presented as the organization's namespace per §3.2 — matched generously as any
      // element whose text content is exactly one of the API's slugs, so this does not depend on a
      // specific class name or test id that the frontend stream may not have added yet.
      const text = await page.content();
      const found = [...apiSlugs].filter((slug) => text.includes(slug));
      return { renderedSlugs: found, requests: seen };
    });

    const missing = [...apiSlugs].filter((slug) => !renderedSlugs.includes(slug));
    c.expect(
      missing.length === 0,
      "every API slug appears somewhere in the rendered page",
      `all ${apiSlugs.size} slug(s) found`,
      `missing from the rendered page: ${missing.join(", ")}`,
    );

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
