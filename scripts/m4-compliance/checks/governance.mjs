/**
 * M4-1 — Governance framework published, and LINKED.
 *
 * Three kinds of evidence, none of which substitutes for another:
 *
 *   1. The four documents exist in the repository, and their GitHub URLs answer 200 — a fact about
 *      the public mirror a reader actually clicks through to.
 *   2. The home page and `/how-it-works` carry an ANCHOR whose href is each of those four exact
 *      URLs. Searching the whole HTML for the substring "GOVERNANCE.md" (what this did before)
 *      matched a serialized flight payload, a code sample, or three of the four being absent.
 *   3. On the home page at least one of them sits OUTSIDE `<footer>`: the plan is explicit that a
 *      link every page carries in its chrome is not the home page linking to the framework.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapLimit, request } from "../../m2-compliance/http.mjs";
import { withPage } from "../browser.mjs";

/** The four governance documents, per §3.1 of the M4 plan. Paths are repo-root relative. */
export const GOVERNANCE_DOCS = [
  { path: "GOVERNANCE.md", section: "## Non-discrimination and ranking", constant: "GOVERNANCE" },
  { path: "REVIEW-CRITERIA.md", section: null, constant: "REVIEW_CRITERIA" },
  { path: "packages/standard/PROCESS.md", section: "## RFC process", constant: "RFC_PROCESS" },
  { path: "PUBLISHERS.md", section: null, constant: "PUBLISHERS_DOC" },
];

const LINKS_MODULE = "packages/frontend/src/lib/links.ts";
const FALLBACK_REPOSITORY = "https://github.com/The-RFP-Hub/the-rfp-hub";

/**
 * The exact hrefs the site is expected to render, read from the single module the frontend
 * centralizes them in rather than restated here as a second set of literals that could drift.
 * Falls back to the canonical construction when that module is not in this checkout.
 */
export function canonicalGovernanceLinks(repoRoot) {
  let source = "";
  try {
    source = readFileSync(join(repoRoot, LINKS_MODULE), "utf8");
  } catch {
    // no frontend in this checkout — the fallback below is the same address by construction
  }
  const repository = /REPOSITORY\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? FALLBACK_REPOSITORY;
  return GOVERNANCE_DOCS.map((doc) => {
    const declared = new RegExp(
      `export const ${doc.constant}\\s*=\\s*\`\\$\\{REPOSITORY\\}([^\`]*)\``,
    ).exec(source)?.[1];
    return {
      ...doc,
      href: declared ? `${repository}${declared}` : `${repository}/blob/main/${doc.path}`,
      repository,
    };
  });
}

/** What each page is held to: the whole framework, or one link in its own content. */
export function governanceCheckName(page) {
  return page.requireAll
    ? `${page.label} links to all four governance documents`
    : `${page.label} links to a governance document outside the footer`;
}

/** Every `<a href>` on the page, and whether it sits inside the global footer. */
async function anchors(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href") ?? "",
      inFooter: a.closest("footer") !== null,
    })),
  );
}

export async function checkGovernance(report, ctx) {
  const links = canonicalGovernanceLinks(ctx.repoRoot);
  const c = report.criterion(
    "M4-1",
    "Governance framework published and linked",
    "The four governance documents exist, their GitHub URLs resolve, the home page and /how-it-works each carry an anchor to all four exact URLs, and at least one of them on the home page is outside the footer.",
  );

  if (ctx.skip.has("governance")) {
    c.skip("governance", "--skip governance");
    return c.finish();
  }

  const present = [];
  for (const doc of links) {
    const full = join(ctx.repoRoot, doc.path);
    const exists = existsSync(full);
    c.expect(
      exists,
      `${doc.path} exists in the repo`,
      full,
      `${doc.path} does not exist at ${full}`,
    );
    if (exists) present.push(doc);

    if (exists && doc.section) {
      c.expect(
        readFileSync(full, "utf8").includes(doc.section),
        `${doc.path} carries the "${doc.section.replace(/^##\s*/, "")}" section`,
        `found "${doc.section}"`,
        `${doc.path} does not contain a "${doc.section}" heading`,
      );
    }
  }

  const ghResults = await mapLimit(present, ctx.concurrency, async (doc) => ({
    doc,
    res: await request(doc.href.split("#")[0], { timeoutMs: ctx.timeoutMs, follow: true }),
  }));
  for (const { doc, res } of ghResults) {
    c.expect(
      res.ok && res.status === 200,
      `${doc.href.split("#")[0]} responds 200`,
      `HTTP ${res.status}`,
      res.ok ? `HTTP ${res.status}` : `transport: ${res.error}`,
    );
  }

  // The plan asks different things of the two pages. `/how-it-works` is the explainer and carries
  // the whole framework; the home page has to reach it in its own content — ONE of the four,
  // outside the global footer, is the requirement, and it deliberately carries two.
  const pages = [
    { path: "/", label: "home", requireAll: false },
    { path: "/how-it-works", label: "/how-it-works", requireAll: true },
  ];

  if (!ctx.browser) {
    for (const page of pages) {
      c.unmet(
        governanceCheckName(page),
        "needs --browser — the page is client-rendered, so a plain GET of the HTML cannot see the anchors",
      );
    }
    return c.finish();
  }

  for (const page of pages) {
    const target = `${ctx.site}${page.path}`;
    let found;
    try {
      found = await withPage(ctx.repoRoot, async (browserPage) => {
        await browserPage.goto(target, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
        return anchors(browserPage);
      });
    } catch (err) {
      c.fail(governanceCheckName(page), `browser check failed: ${err.message}`);
      continue;
    }

    if (page.requireAll) {
      const missing = links.filter((doc) => !found.some((a) => a.href === doc.href));
      c.expect(
        missing.length === 0,
        governanceCheckName(page),
        `all four exact hrefs present on ${target}`,
        `no <a href="…"> on ${target} for: ${missing.map((d) => d.href).join(", ")}`,
      );
      continue;
    }

    // Outside the footer, because a link the global chrome carries on every page is not this page
    // linking to the framework. Still an EXACT href match, against the same four canonical URLs.
    const outside = links.filter((doc) => found.some((a) => a.href === doc.href && !a.inFooter));
    c.expect(
      outside.length > 0,
      governanceCheckName(page),
      `${outside.length} of four in the page's own content: ${outside.map((d) => d.path).join(", ")}`,
      `no <a href="…"> outside <footer> on ${target} for any of: ${links.map((d) => d.path).join(", ")}`,
    );
  }

  return c.finish();
}
