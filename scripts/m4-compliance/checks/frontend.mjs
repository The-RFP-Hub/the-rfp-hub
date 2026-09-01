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
import { isLoopbackHost, probeTls, request } from "../../m2-compliance/http.mjs";
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

/** The minimum touch target the plan requires of every interactive control, in CSS pixels. */
export const MIN_TARGET_PX = 44;

const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));

/**
 * Assert that a filter/search/pagination change actually changed WHICH entries are on screen.
 *
 * Two failure modes this closes, both of which used to pass. An EMPTY result satisfies "different
 * from the baseline" while proving nothing except that the param maybe reached the query string —
 * it is exactly as consistent with a broken filter matching nothing. And a REORDERING of the same
 * ids is not a different result set at all: `JSON.stringify` inequality accepted it, and the unit
 * test locked that in.
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
    !sameSet(new Set(newIds), new Set(baselineIds)),
    name,
    `${newIds.length} item(s), a different set from the baseline's ${baselineIds.length}`,
    `rendered the same ${newIds.length} entries as the baseline (a reordering is not a different result set) — the filter may not be wired to the list`,
  );
}

/** The API query the directory itself makes for a selection, per packages/frontend/src/lib. */
function directoryQuery({ ecosystem, fundingType, page = 1 } = {}) {
  const qs = new URLSearchParams({
    status: "open",
    sort: "nextDeadlineAt",
    order: "asc",
    page: String(page),
    limit: "20",
  });
  if (ecosystem) qs.set("ecosystem", ecosystem);
  if (fundingType) qs.set("fundingType", fundingType);
  return qs;
}

async function listIds(ctx, qs) {
  const res = await request(`${ctx.api}/v1/opportunities?${qs}`, { timeoutMs: ctx.timeoutMs });
  if (!res.ok || res.status !== 200) return null;
  try {
    return (JSON.parse(res.body).items ?? []).map((item) => item.id);
  } catch {
    return null;
  }
}

/**
 * Two filter values the LIVE corpus can actually answer, one per filter the plan names. Hard-coding
 * `type=grant` made the assertion fail for the wrong reason the day the corpus stopped matching it,
 * and there was no second filter at all.
 */
export async function deriveFilterValues(ctx) {
  const res = await request(`${ctx.api}/v1/opportunities?status=open&limit=100`, {
    timeoutMs: ctx.timeoutMs,
  });
  if (!res.ok || res.status !== 200) return {};
  let items;
  try {
    items = JSON.parse(res.body).items ?? [];
  } catch {
    return {};
  }
  const first = (values) => [...new Set(values.filter(Boolean))][0];
  return {
    fundingType: first(items.map((item) => item.fundingType)),
    ecosystem: first(items.flatMap((item) => item.ecosystems ?? [])),
  };
}

/**
 * Every control small enough to miss on a touch screen. Inline links inside running text are
 * exempt: their hit area is the line box, and enlarging one would break the paragraph it sits in.
 */
async function undersizedTargets(page, min) {
  return await page.evaluate((minPx) => {
    const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';
    const offenders = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (rect.width === 0 || rect.height === 0) continue;
      const inlineInProse =
        el.tagName === "A" &&
        style.display.startsWith("inline") &&
        el.closest("p, li, small, figcaption, td, blockquote") !== null;
      if (inlineInProse) continue;
      if (rect.width >= minPx && rect.height >= minPx) continue;
      offenders.push(
        `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      );
    }
    return offenders;
  }, min);
}

export async function checkFrontend(report, ctx) {
  const c = report.criterion(
    "M4-3",
    "Reference frontend is live and behaves",
    "TLS, liveness, search and two filters and pagination each changing WHICH entries are shown and matching the API, the detail page's visible heading, both deep-link hrefs, and three viewports with no horizontal overflow and no interactive control under 44×44 px.",
  );

  if (ctx.skip.has("frontend")) {
    c.skip("frontend", "--skip frontend");
    return c.finish();
  }

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
  } else if (isLoopbackHost(new URL(ctx.site).hostname)) {
    c.skipOptional("TLS certificate is valid", `${ctx.site} is loopback — no transport to inspect`);
  } else {
    // Recorded as a SKIP before, which meant a remote plaintext deployment passed this criterion.
    c.fail("TLS certificate is valid", `${ctx.site} is served over ${tls.protocol}, not https`);
  }

  const homeRes = await request(ctx.site, { timeoutMs: ctx.timeoutMs });
  c.expect(
    homeRes.ok && homeRes.status === 200,
    `GET ${ctx.site}/ → 200`,
    `HTTP ${homeRes.status}, ${homeRes.elapsedMs}ms`,
    homeRes.ok ? `HTTP ${homeRes.status}` : `transport: ${homeRes.error}`,
  );

  checkIndexability(
    c,
    ctx,
    homeRes,
    await request(`${ctx.site}/robots.txt`, { timeoutMs: ctx.timeoutMs }),
  );

  const filters = ctx.browser ? await deriveFilterValues(ctx) : {};
  if (!ctx.browser) {
    for (const name of [
      "search q changes the result set",
      "an ecosystem filter changes the result set, and matches the API",
      "a funding-type filter changes the result set, and matches the API",
      "page=2 changes the result set",
      "detail page's visible heading is the title",
      "apply href equals {api}/v1/r/{id}/apply",
      "source href equals {api}/v1/r/{id}/source",
      ...VIEWPORTS.flatMap((v) => [
        `no horizontal overflow at ${v.label}`,
        `every interactive control is at least ${MIN_TARGET_PX}×${MIN_TARGET_PX} px at ${v.label}`,
      ]),
    ]) {
      c.unmet(name, "needs --browser");
    }
    return c.finish();
  }

  try {
    await withPage(ctx.repoRoot, async (page) => {
      await page.goto(ctx.site, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      const baseline = await renderedOpportunityIds(page);
      c.expect(
        baseline.length > 0,
        "baseline result set at / is non-empty",
        `${baseline.length} item(s) rendered`,
        "/ rendered ZERO items — every comparison below needs a real baseline, and an empty one would make 'different from baseline' true for the wrong reason",
      );

      await page.goto(`${ctx.site}/?q=grant`, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      expectResultSetChanged(
        c,
        "search q=grant changes the result set",
        await renderedOpportunityIds(page),
        baseline,
        "the query param may not be wired to the list.",
      );

      // The URL param is `type`, NOT `fundingType` — `selectionFromParams` in
      // packages/frontend/src/lib/directory.ts reads `type` and maps it onto the internal
      // `fundingType` field. `?fundingType=` would be an unrecognized param the directory silently
      // ignores, failing this check for the wrong reason.
      for (const [param, key, label] of [
        ["ecosystem", "ecosystem", "ecosystem"],
        ["type", "fundingType", "funding-type"],
      ]) {
        const value = filters[key];
        const name = `a ${label} filter changes the result set, and matches the API`;
        if (!value) {
          c.unmet(
            name,
            `no ${key} value appears in the first 100 open entries at ${ctx.api}, so this filter cannot be exercised against live data`,
          );
          continue;
        }
        await page.goto(`${ctx.site}/?${param}=${encodeURIComponent(value)}`, {
          waitUntil: "networkidle",
          timeout: ctx.timeoutMs,
        });
        const rendered = await renderedOpportunityIds(page);
        expectResultSetChanged(
          c,
          `${label} filter ${param}=${value} changes the result set`,
          rendered,
          baseline,
          `the filter may not be wired to the list, or the corpus has only ${label} ${value}.`,
        );
        const apiIds = await listIds(ctx, directoryQuery({ [key]: value }));
        if (apiIds === null) {
          c.fail(name, `could not fetch the comparison list from ${ctx.api}/v1/opportunities`);
          continue;
        }
        const missing = apiIds.filter((id) => !rendered.includes(id));
        const extra = rendered.filter((id) => !apiIds.includes(id));
        c.expect(
          missing.length === 0 && extra.length === 0,
          name,
          `${rendered.length} rendered entries are exactly what ${param}=${value} returns`,
          `rendered but not in the API's result: ${extra.join(", ") || "(none)"}; in the API's result but not rendered: ${missing.join(", ") || "(none)"}`,
        );
      }

      await page.goto(`${ctx.site}/?page=2`, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
      expectResultSetChanged(
        c,
        "page=2 changes the result set",
        await renderedOpportunityIds(page),
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

  const oneRes = await request(`${ctx.api}/v1/opportunities?limit=1`, { timeoutMs: ctx.timeoutMs });
  let sample;
  try {
    sample = oneRes.ok ? JSON.parse(oneRes.body)?.items?.[0] : undefined;
  } catch {
    sample = undefined;
  }
  if (!sample) {
    c.fail(
      "detail page's visible heading is the title",
      `could not fetch a sample opportunity from ${ctx.api}/v1/opportunities?limit=1 to test against`,
    );
  } else {
    try {
      await withPage(ctx.repoRoot, async (page) => {
        const detailUrl = `${ctx.site}/opportunities/${encodeURIComponent(sample.id)}`;
        const response = await page.goto(detailUrl, {
          waitUntil: "networkidle",
          timeout: ctx.timeoutMs,
        });
        c.expect(
          response?.status() === 200,
          `GET ${detailUrl} → 200`,
          `HTTP ${response?.status()}`,
          `HTTP ${response?.status()}`,
        );
        // The RENDERED heading, not `page.content()`: a substring search over the serialized HTML
        // matched Next.js's own flight payload (a pass with nothing visible on screen) and missed a
        // correctly displayed title whose `&` had been escaped (a failure with nothing wrong).
        const heading = await page.evaluate(
          () => document.querySelector("h1")?.innerText?.replace(/\s+/g, " ").trim() ?? "",
        );
        const expected = sample.title.replace(/\s+/g, " ").trim();
        c.expect(
          heading === expected || heading.includes(expected),
          "detail page's visible heading is the title",
          `<h1> reads "${heading}"`,
          `<h1> reads "${heading}", the API's title is "${expected}"`,
        );

        const expectedApply = `${ctx.api}/v1/r/${encodeURIComponent(sample.id)}/apply`;
        const expectedSource = `${ctx.api}/v1/r/${encodeURIComponent(sample.id)}/source`;
        const hrefs = await page.evaluate(() =>
          [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
        );
        for (const [expectedHref, label] of [
          [expectedApply, "apply"],
          [expectedSource, "source"],
        ]) {
          c.expect(
            hrefs.includes(expectedHref),
            `${label} href equals {api}/v1/r/{id}/${label}`,
            expectedHref,
            `no <a href="${expectedHref}"> found; hrefs seen: ${hrefs.filter((h) => h?.includes("/v1/r/")).join(", ") || "(none matching /v1/r/)"}`,
          );
        }
      });
    } catch (err) {
      c.fail("detail page's visible heading is the title", `browser check failed: ${err.message}`);
    }
  }

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
          const offenders = await undersizedTargets(page, MIN_TARGET_PX);
          c.expect(
            offenders.length === 0,
            `every interactive control is at least ${MIN_TARGET_PX}×${MIN_TARGET_PX} px at ${viewport.label} on ${route}`,
            "every control meets the minimum",
            `${offenders.length} control(s) under ${MIN_TARGET_PX} px: ${offenders.slice(0, 5).join("; ")}${offenders.length > 5 ? ` … and ${offenders.length - 5} more` : ""}`,
          );
        }
      });
    } catch (err) {
      c.fail(`responsive checks at ${viewport.label}`, `browser check failed: ${err.message}`);
    }
  }

  return c.finish();
}

/**
 * Index state is REPORTED, not held to a contract, because the decision is the operator's — unless
 * `--expect-indexable` says the deployment is meant to be indexed, in which case a whole-site
 * Disallow or a noindex meta tag is a failure rather than a note.
 */
function checkIndexability(c, ctx, homeRes, robotsRes) {
  const robots = robotsRes.ok && robotsRes.status === 200 ? robotsRes.body : undefined;
  const detail = robots
    ? robots.trim().slice(0, 500)
    : robotsRes.ok
      ? `HTTP ${robotsRes.status}`
      : `transport: ${robotsRes.error}`;
  const blanket = robots
    ? /^\s*user-agent:\s*\*[\s\S]*?^\s*disallow:\s*\/\s*$/im.test(robots)
    : false;
  const noindex =
    homeRes.ok && typeof homeRes.body === "string"
      ? /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(homeRes.body)
      : false;

  if (!ctx.expectIndexable) {
    c.info("robots.txt", detail);
    if (blanket || noindex) {
      c.info(
        "indexability",
        `${blanket ? "robots.txt disallows the whole site" : ""}${blanket && noindex ? "; " : ""}${noindex ? "the home page carries a noindex meta tag" : ""} — reported, not failed (pass --expect-indexable to require indexability)`,
      );
    }
    return;
  }
  c.expect(
    Boolean(robots) && !blanket,
    "--expect-indexable: robots.txt does not disallow the whole site",
    detail,
    robots
      ? `robots.txt disallows / for every user-agent:\n${detail}`
      : `no robots.txt — ${detail}`,
  );
  c.expect(
    !noindex,
    "--expect-indexable: the home page carries no noindex meta tag",
    "no robots meta tag with noindex",
    `${ctx.site}/ carries <meta name="robots" content="…noindex…">`,
  );
}
