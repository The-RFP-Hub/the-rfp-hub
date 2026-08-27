/**
 * M4-3 — the reference frontend is alive, and behaves.
 *
 * Read-only in every part: TLS, a plain `/` fetch, and `/robots.txt` need no browser. Everything
 * that requires seeing the RENDERED page — search changing the result set, a filter changing it,
 * pagination, the detail page's title, the two deep-link hrefs, and the three responsive
 * viewports — needs `--browser`, and per the brief §4.4 row "3c" the responsive check in
 * particular is REQUIRED, not skippable, once `--browser` is on.
 *
 * The two deep-link hrefs are inspected, never followed: `captureViews` records a view before the
 * 302 fires, and a `HEAD`/`GET` from this checker would register as a real click against
 * whichever publisher's analytics the fixture happens to point at. `getAttribute('href')` in the
 * page context never triggers navigation.
 */
import { probeTls, request } from "../../m2-compliance/http.mjs";
import { withPage } from "../browser.mjs";

const VIEWPORTS = [
  { width: 375, height: 667, label: "375×667 (mobile)" },
  { width: 768, height: 1024, label: "768×1024 (tablet)" },
  { width: 1440, height: 900, label: "1440×900 (desktop)" },
];

/**
 * Pull the opportunity ids the rendered directory table is currently showing — one per row, in
 * page order.
 *
 * `tbody a.row-title` is what `DirectoryRow` in `packages/frontend/src/components/DirectoryList.tsx`
 * actually renders: `<Link href={`/opportunities/${encodeURIComponent(item.id)}`} className="row-title">`.
 * There is no `data-opportunity-id` (or any other purpose-built test attribute) anywhere in
 * `packages/frontend/src` — an earlier revision of this file assumed one existed and silently fell
 * back to a looser `a[href*="/opportunities/"]` selector that this checker never actually exercised
 * against a real page, because `/publishers` (unrelated) also links to `/opportunities/…`-shaped
 * search results and would have double-counted them. `.row-title` is reused elsewhere in the
 * frontend (organizations, review, account pages), but never on the public directory route this
 * function is only ever called against, so `tbody a.row-title` is unambiguous here.
 *
 * The id is decoded back out of the href rather than read off a data attribute, which is a
 * STRONGER assertion than a bare count: two pages rendering the same NUMBER of rows with
 * DIFFERENT ids still correctly counts as "the result set changed".
 */
async function renderedOpportunityIds(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll("tbody a.row-title")]
      .map((a) => a.getAttribute("href") ?? "")
      .map((href) => href.replace(/^\/opportunities\//, ""))
      .filter((encoded) => encoded.length > 0)
      .map((encoded) => decodeURIComponent(encoded)),
  );
}

/**
 * Assert that a filter/search/pagination change actually changed what is on screen — and that an
 * EMPTY result is never accepted as proof of that. `JSON.stringify(a) !== JSON.stringify(b)` alone
 * is satisfied just as well by "0 items" vs "20 items" as by "20 different items", and the former
 * proves nothing except that the param maybe reached the query string; it is exactly as consistent
 * with a broken filter that matches nothing as with a correctly narrowed one.
 */
export function expectResultSetChanged(c, name, newIds, baselineIds, emptyHint) {
  if (newIds.length === 0) {
    c.fail(
      name,
      `rendered ZERO items — an empty result set is not evidence the filter works (it is equally consistent with a broken filter matching nothing). ${emptyHint}`,
    );
    return;
  }
  c.expect(
    JSON.stringify(newIds) !== JSON.stringify(baselineIds),
    name,
    `${newIds.length} item(s), different from baseline's ${baselineIds.length}`,
    `rendered the same ${newIds.length} item(s), in the same order, as the baseline — the filter may not be wired to the list`,
  );
}

export async function checkFrontend(report, ctx) {
  const c = report.criterion(
    "M4-3",
    "Reference frontend is live and behaves",
    "TLS, liveness, search/filter/pagination changing the result set, the detail page, both deep-link hrefs, and three responsive viewports with no horizontal overflow.",
  );

  if (ctx.skip.has("frontend")) {
    c.skip("frontend", "--skip frontend");
    return c.finish();
  }

  // ── TLS + liveness (no browser needed) ────────────────────────────────
  const tls = await probeTls(ctx.site, { timeoutMs: ctx.timeoutMs });
  if (tls.applicable) {
    c.expect(
      tls.valid,
      "TLS certificate is valid",
      `${tls.subject ?? ctx.site}, ${tls.daysRemaining ?? "?"} day(s) remaining`,
      tls.error ?? "certificate invalid",
    );
    if (tls.valid && typeof tls.daysRemaining === "number" && tls.daysRemaining < 14) {
      c.warn("TLS certificate lifetime", `only ${tls.daysRemaining} day(s) remaining`);
    }
  } else {
    c.skip("TLS certificate is valid", `${ctx.site} is not https`);
  }

  const homeRes = await request(ctx.site, { timeoutMs: ctx.timeoutMs });
  c.expect(
    homeRes.ok && homeRes.status === 200,
    `GET ${ctx.site}/ → 200`,
    `HTTP ${homeRes.status}, ${homeRes.elapsedMs}ms`,
    homeRes.ok ? `HTTP ${homeRes.status}` : `transport: ${homeRes.error}`,
  );

  // ── robots.txt — REPORTED, never failed ────────────────────────────────
  const robotsUrl = `${ctx.site}/robots.txt`;
  const robotsRes = await request(robotsUrl, { timeoutMs: ctx.timeoutMs });
  if (robotsRes.ok && robotsRes.status === 200) {
    c.info("robots.txt", robotsRes.body.trim().slice(0, 500));
  } else {
    c.info(
      "robots.txt",
      robotsRes.ok ? `HTTP ${robotsRes.status}` : `transport: ${robotsRes.error}`,
    );
  }

  if (!ctx.browser) {
    for (const name of [
      "search q changes the result set",
      "a type (funding type) filter changes the result set",
      "page=2 changes the result set",
      "detail page shows the title",
      "apply href equals {api}/v1/r/{id}/apply",
      "source href equals {api}/v1/r/{id}/source",
      ...VIEWPORTS.map((v) => `no horizontal overflow at ${v.label}`),
    ]) {
      c.warn(name, "needs --browser");
    }
    return c.finish();
  }

  // ── everything below needs a rendered page ──────────────────────────────
  try {
    await withPage(ctx.repoRoot, async (page) => {
      await page.goto(ctx.site, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      const baseline = await renderedOpportunityIds(page);
      c.expect(
        baseline.length > 0,
        "baseline result set at / is non-empty",
        `${baseline.length} item(s) rendered`,
        "/ rendered ZERO items — every comparison below needs a real baseline to compare against, and an empty one would make 'different from baseline' true for the wrong reason",
      );

      // search `q`
      await page.goto(`${ctx.site}/?q=grant`, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      const searched = await renderedOpportunityIds(page);
      expectResultSetChanged(
        c,
        "search q=grant changes the result set",
        searched,
        baseline,
        "the query param may not be wired to the list.",
      );

      // Funding-type filter. The URL param is `type`, NOT `fundingType` — confirmed against
      // `selectionFromParams` in packages/frontend/src/lib/directory.ts, which reads `type` and
      // maps it onto the internal `DirectorySelection.fundingType` field. `?fundingType=grant`
      // would be an unrecognized param the directory silently ignores, which would make this
      // check fail for the wrong reason (param name) rather than the right one (filter wiring).
      await page.goto(`${ctx.site}/?type=grant`, {
        waitUntil: "networkidle",
        timeout: ctx.timeoutMs,
      });
      const filtered = await renderedOpportunityIds(page);
      expectResultSetChanged(
        c,
        "type=grant filter changes the result set",
        filtered,
        baseline,
        "the filter may not be wired to the list, OR there are genuinely zero grant-type listings right now — check the dataset before assuming a bug.",
      );

      // pagination
      await page.goto(`${ctx.site}/?page=2`, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      const paged = await renderedOpportunityIds(page);
      expectResultSetChanged(
        c,
        "page=2 changes the result set",
        paged,
        baseline,
        "either there is only one page of data (check /v1/stats before assuming a bug) or pagination is not wired.",
      );
    });
  } catch (err) {
    c.fail(
      "search/filter/pagination change the result set",
      `browser check failed: ${err.message}`,
    );
  }

  // ── detail page + deep links ─────────────────────────────────────────────
  const oneRes = await request(`${ctx.api}/v1/opportunities?limit=1`, { timeoutMs: ctx.timeoutMs });
  let sample;
  try {
    sample = oneRes.ok ? JSON.parse(oneRes.body)?.items?.[0] : undefined;
  } catch {
    sample = undefined;
  }
  if (!sample) {
    c.fail(
      "detail page shows the title",
      `could not fetch a sample opportunity from ${ctx.api}/v1/opportunities?limit=1 to test against`,
    );
  } else {
    try {
      await withPage(ctx.repoRoot, async (page) => {
        const detailUrl = `${ctx.site}/opportunities/${encodeURIComponent(sample.id)}`;
        await page.goto(detailUrl, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
        const html = await page.content();
        c.expect(
          html.includes(sample.title),
          "detail page shows the title",
          `"${sample.title}" found on ${detailUrl}`,
          `"${sample.title}" not found on ${detailUrl}`,
        );

        const expectedApply = `${ctx.api}/v1/r/${encodeURIComponent(sample.id)}/apply`;
        const expectedSource = `${ctx.api}/v1/r/${encodeURIComponent(sample.id)}/source`;
        const hrefs = await page.evaluate(() =>
          [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
        );
        c.expect(
          hrefs.includes(expectedApply),
          "apply href equals {api}/v1/r/{id}/apply",
          expectedApply,
          `no <a href="${expectedApply}"> found; hrefs seen: ${hrefs.filter((h) => h?.includes("/v1/r/")).join(", ") || "(none matching /v1/r/)"}`,
        );
        c.expect(
          hrefs.includes(expectedSource),
          "source href equals {api}/v1/r/{id}/source",
          expectedSource,
          `no <a href="${expectedSource}"> found; hrefs seen: ${hrefs.filter((h) => h?.includes("/v1/r/")).join(", ") || "(none matching /v1/r/)"}`,
        );
      });
    } catch (err) {
      c.fail("detail page shows the title", `browser check failed: ${err.message}`);
    }
  }

  // ── responsive viewports — REQUIRED, no SKIP ───────────────────────────
  const routes = [
    "/",
    `/opportunities/${sample ? encodeURIComponent(sample.id) : ""}`,
    "/publishers",
  ];
  for (const viewport of VIEWPORTS) {
    try {
      await withPage(ctx.repoRoot, async (page) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const route of routes) {
          if (route.endsWith("/opportunities/")) continue; // no sample id available
          await page.goto(`${ctx.site}${route}`, {
            waitUntil: "networkidle",
            timeout: ctx.timeoutMs,
          });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          c.expect(
            !overflow,
            `no horizontal overflow at ${viewport.label} on ${route}`,
            "scrollWidth <= innerWidth",
            "document.documentElement.scrollWidth > window.innerWidth",
          );
        }
      });
    } catch (err) {
      c.fail(`no horizontal overflow at ${viewport.label}`, `browser check failed: ${err.message}`);
    }
  }

  return c.finish();
}
