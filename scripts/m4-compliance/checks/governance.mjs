/**
 * M4-1 — Governance framework published, and LINKED.
 *
 * Two different kinds of evidence, and neither substitutes for the other:
 *
 *   1. The four documents exist in the repository (a filesystem fact) and their GitHub URLs
 *      answer 200 (a fact about the public mirror a reader actually clicks through to).
 *   2. The site LINKS to at least the non-discrimination policy from its home page and from
 *      `/how-it-works`. The page is client-rendered, so a plain `fetch` of the server HTML often
 *      sees an all-but-empty shell — this checker does NOT fall back to fetching Next.js's RSC/
 *      flight payload to work around that (parsing an undocumented internal wire format would be
 *      a second, unofficial contract to keep in sync). It reports a fully rendered check as a WARN
 *      naming exactly what is needed, rather than fabricating a pass or a fail.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapLimit, request } from "../../m2-compliance/http.mjs";
import { withPage } from "../browser.mjs";

/** The four governance documents, per §3.1 of the M4 plan. Paths are repo-root relative. */
export const GOVERNANCE_DOCS = [
  { path: "GOVERNANCE.md", section: "## Non-discrimination and ranking" },
  { path: "REVIEW-CRITERIA.md", section: null },
  { path: "packages/standard/PROCESS.md", section: "## RFC process" },
  { path: "PUBLISHERS.md", section: null },
];

/** The project's own repository URL, read from the single module the frontend centralizes it in
 * (`packages/frontend/src/lib/links.ts`) rather than restated as a second literal here that could
 * drift from it. Falls back to the known canonical address if that file is missing or reshaped. */
function repositoryUrl(repoRoot) {
  const fallback = "https://github.com/The-RFP-Hub/the-rfp-hub";
  try {
    const src = readFileSync(join(repoRoot, "packages/frontend/src/lib/links.ts"), "utf8");
    const match = /REPOSITORY\s*=\s*"([^"]+)"/.exec(src);
    return match ? match[1] : fallback;
  } catch {
    return fallback;
  }
}

export async function checkGovernance(report, ctx) {
  const c = report.criterion(
    "M4-1",
    "Governance framework published and linked",
    "The four governance documents exist in the repo, their GitHub URLs resolve, and the site links to the policy from the home page and /how-it-works.",
  );

  if (ctx.skip.has("governance")) {
    c.skip("governance", "--skip governance");
    return c.finish();
  }

  // ── (1) the four documents exist ──────────────────────────────────────────
  const present = [];
  for (const doc of GOVERNANCE_DOCS) {
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
      const text = readFileSync(full, "utf8");
      c.expect(
        text.includes(doc.section),
        `${doc.path} carries the "${doc.section.replace(/^##\s*/, "")}" section`,
        `found "${doc.section}"`,
        `${doc.path} does not contain a "${doc.section}" heading`,
      );
    }
  }

  // ── (2) GitHub URLs 200 ─────────────────────────────────────────────────
  const repo = repositoryUrl(ctx.repoRoot);
  const ghResults = await mapLimit(present, ctx.concurrency, async (doc) => {
    const ghUrl = `${repo}/blob/main/${doc.path}`;
    const res = await request(ghUrl, { timeoutMs: ctx.timeoutMs, follow: true });
    return { doc, ghUrl, res };
  });
  for (const { doc, ghUrl, res } of ghResults) {
    c.expect(
      res.ok && res.status === 200,
      `${ghUrl} responds 200`,
      `HTTP ${res.status}`,
      res.ok ? `HTTP ${res.status}` : `transport: ${res.error}`,
    );
  }

  // ── (3) linked from the site ────────────────────────────────────────────
  const govHref = "GOVERNANCE.md";
  const pages = [
    { path: "/", label: "home" },
    { path: "/how-it-works", label: "/how-it-works" },
  ];

  for (const page of pages) {
    const target = `${ctx.site}${page.path}`;
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    const serverHasLink = res.ok && typeof res.body === "string" && res.body.includes(govHref);

    if (serverHasLink) {
      c.pass(
        `${page.label} links to GOVERNANCE.md (server HTML)`,
        `found "${govHref}" in the response body of ${target}`,
      );
      continue;
    }

    if (!ctx.browser) {
      c.unmet(
        `${page.label} links to GOVERNANCE.md`,
        `not found in server HTML at ${target} (expected — the page is client-rendered); pass --browser to render it`,
      );
      continue;
    }

    try {
      const found = await withPage(ctx.repoRoot, async (browserPage) => {
        await browserPage.goto(target, { waitUntil: "networkidle", timeout: ctx.timeoutMs });
        const html = await browserPage.content();
        return html.includes(govHref);
      });
      c.expect(
        found,
        `${page.label} links to GOVERNANCE.md (rendered)`,
        `found "${govHref}" in the rendered DOM`,
        `no link to ${govHref} found anywhere in the rendered ${page.label} page — add it to the footer (Chrome.tsx) or, for the home page, a link outside the global footer`,
      );
    } catch (err) {
      c.fail(
        `${page.label} links to GOVERNANCE.md (rendered)`,
        `browser check failed: ${err.message}`,
      );
    }
  }

  return c.finish();
}
