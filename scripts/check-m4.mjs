#!/usr/bin/env node
/**
 * M4 sign-off compliance checker.
 *
 * Mechanically verifies the M4 completion criteria against a LIVE, PUBLIC deployment:
 *
 *   1. Governance      the four governance documents exist and are linked from the site
 *   2. Publishers      the public /publishers page matches GET /v1/publishers, unauthenticated
 *   3. Frontend        the reference frontend is live, searchable, filterable, paginated, and
 *                      responsive at three viewports, with both deep-link hrefs correct
 *   4. MCP             the MCP server is installable, lists the right tools, matches the API, never
 *                      leaks a credential-shaped string, and fails closed on submission
 *   5. Skill           the agent skill's frontmatter is valid and its helper never emits `description`
 *   6. Docs            the four handoff guides exist, every link resolves, and only safe-read
 *                      shell blocks are ever executed
 *
 * HOW THIS DIFFERS FROM `check-m3.mjs`, AND WHY IT NEEDS NO `--allow-production`.
 * Like `check-m2.mjs`, this tool is 100% READ-ONLY: it never mints a key, never submits a real
 * entry, never asks a reviewer to do anything. The one thing that could look like a write —
 * `submit_opportunity` under M4-4 — is deliberately run against a LOCAL recording HTTP server this
 * checker starts itself, never against `--api`, precisely so this tool can default to production
 * and cost the deployment nothing to run, same as check-m2.
 *
 * Usage:
 *   node scripts/check-m4.mjs --site https://ethrfps.app --api https://api.ethrfps.app --browser
 *
 * Exit codes: 0 every criterion exercised and held · 1 a criterion failed, or one was never
 * exercised · 2 the run could not be made.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBase } from "./m2-compliance/http.mjs";
import { checkDocs } from "./m4-compliance/checks/docs.mjs";
import { checkFrontend } from "./m4-compliance/checks/frontend.mjs";
import { checkGovernance } from "./m4-compliance/checks/governance.mjs";
import { checkMcp } from "./m4-compliance/checks/mcp.mjs";
import { checkPublishers } from "./m4-compliance/checks/publishers.mjs";
import { checkSkill } from "./m4-compliance/checks/skill.mjs";
import { CHECK_IDS, describeScope, parseArgs } from "./m4-compliance/options.mjs";
import { Report } from "./m4-compliance/report.mjs";

const USAGE = `M4 sign-off compliance checker

  node scripts/check-m4.mjs [options]

This tool is READ-ONLY. It never mints a key, submits an entry, or asks a reviewer to do anything —
the one case that could look like a write (MCP submit_opportunity's fail-closed behavior) runs
against a local recording server this checker starts itself, never against --api. The defaults
already point at production, on purpose.

Options
  --site <url>            The reference frontend. Default: https://ethrfps.app
  --api <url>             The API. Default: https://api.ethrfps.app
  --repo-root <path>      Repo checkout to read docs/skills/etc. from. Default: cwd.
  --browser               Use Playwright (resolved via packages/e2e) for checks that need a
                          rendered DOM: governance link rendering, /publishers slugs, the
                          frontend's search/filter/pagination/detail/deep-links/responsive checks.
                          Without it those requirements are reported UNMET, which makes their
                          criterion INCOMPLETE and the run exit 1 — never a silent pass.
  --offline               Skip the network requests the DOCS criterion would otherwise make
                          (absolute link 2xx/3xx checks, safe-read block execution). Every other
                          criterion still uses the network, so the intended combination is
                          --only docs --offline, which the docs-links CI job runs. A run with
                          --offline is labeled a scoped lint, never an M4 sign-off.
  --expect-indexable      Make the robots/indexability row a REQUIREMENT: fail when robots.txt
                          disallows the whole site or the home page carries a noindex meta tag.
                          Without it the row stays report-only (the index decision is the
                          operator's, per the plan).
  --mcp-spec <spec>       npm version for the MCP check's \`npx -y @the-rfp-hub/mcp@<spec>\`.
                          Default: "next" — the REAL npm registry, which is what "installable"
                          means; before the package is published this fails, honestly. Pass
                          "local" to exercise packages/mcp/dist/cli.js directly instead (an
                          explicit opt-out for developing the package before publish — the
                          criterion is renamed and says plainly it is not evidence of publication).
  --skip <check>          Skip one check by id (repeatable). One of: ${CHECK_IDS.join(", ")}.
                          Still REGISTERS a skip criterion, so the run reports "incomplete".
  --only <check>          Run only this check (repeatable). The others are not registered at all,
                          so a passing scoped run is a clean PASS/exit 0, not "incomplete". Used
                          by the docs-links CI job (\`--only docs\`). Refused together with --skip.
  --json <path>           Where to write the machine-readable report.
                          Default: <os.tmpdir()>/m4-compliance-report-<pid>-<timestamp>.json,
                          printed after the run — this tool is read-only, a repo-root default
                          would write into the caller's own checkout, and a CONSTANT temp name
                          makes two concurrent runs overwrite each other's evidence. Use "-" for
                          stdout.
  --concurrency <n>       Requests in flight. Default: 6.
  --timeout <ms>          Per-request/process timeout. Default: 15000.
  --no-color              Plain output.
  -h, --help              This text.
`;

function defaultReportName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `m4-compliance-report-${process.pid}-${stamp}.json`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    opts.site = normalizeBase(opts.site, "--site");
    opts.api = normalizeBase(opts.api, "--api");
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const ctx = { ...opts };
  const scopeLabel = describeScope(opts);
  const report = new Report({
    siteUrl: ctx.site,
    baseUrl: ctx.api,
    repoRoot: ctx.repoRoot,
    browser: ctx.browser,
    offline: ctx.offline,
    mcpSpec: ctx.mcpSpec ?? "next",
    ...(scopeLabel ? { scopeLabel } : {}),
    node: process.version,
  });

  // `--only` EXCLUDES a check from running at all — no criterion is registered for it, so it
  // cannot turn the run `incomplete`. `--skip` (handled inside each check module) still registers
  // a `skip` criterion, which does. See options.mjs's docstring for why these are not the same
  // flag and are refused together.
  const runs = [
    ["governance", checkGovernance],
    ["publishers", checkPublishers],
    ["frontend", checkFrontend],
    ["mcp", checkMcp],
    ["skill", checkSkill],
    ["docs", checkDocs],
  ];
  for (const [id, check] of runs) {
    if (ctx.only.size > 0 && !ctx.only.has(id)) continue;
    await check(report, ctx);
  }

  process.stdout.write(`${report.render({ color: opts.color })}\n`);

  // The OS temp dir, not the repo root: a "safe to run anywhere, including production" tool must
  // not write into the caller's own checkout. Unique per run, because a constant name lets two
  // concurrent runs silently overwrite each other's evidence. Printed either way.
  const jsonPath = opts.json ?? join(tmpdir(), defaultReportName());
  const serialized = `${JSON.stringify(report.toJSON(), null, 2)}\n`;
  if (jsonPath === "-") {
    process.stdout.write(serialized);
  } else {
    writeFileSync(jsonPath, serialized);
    process.stdout.write(`\nJSON report written to ${jsonPath}\n`);
  }

  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`m4-compliance: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
