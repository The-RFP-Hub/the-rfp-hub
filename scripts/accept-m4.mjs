#!/usr/bin/env node
/**
 * M4 write-acceptance — the real 3-phase MCP submission interlock, driven end to end.
 *
 * `check-m4.mjs` is entirely read-only, including its MCP check: the one case that looks like a
 * write (`submit_opportunity` with the fail-closed env) runs against a LOCAL mock server, never
 * against a real deployment. This tool is the other half — it drives the actual interlock against
 * a real, writable STAGING deployment:
 *
 *   1. preview   `submit_opportunity` phase 1 — no network write, returns `pending` + an approvalId
 *   2. approve   a SEPARATE process runs `rfphub-mcp approve <approvalId>`, simulating the human
 *                step the plan requires never be reachable from inside the MCP channel itself
 *   3. commit    `submit_opportunity` phase 3 — the actual `POST`, now that an approval exists
 *
 * ...then verifies the fixture landed `pending` via `GET /v1/me/opportunities` (never the public
 * read surface, which hides pending entries by design), and tears it down — rejected and unlisted
 * by a reviewer — the same as `m3-compliance/cleanup.mjs`.
 *
 * WHY THIS REFUSES PRODUCTION THE SAME WAY check-m3 DOES. This tool writes a real entry through a
 * real interlock. `--allow-production` unlocks a target that doesn't look like staging, and PRINTS
 * A RED WARNING when it does — there is no further flag to force past that warning; passing
 * `--allow-production` already is the forcing.
 *
 * Usage:
 *   RFPHUB_REVIEWER_TOKEN=... RFPHUB_WRITE_KEY=rfph_... \
 *     node scripts/accept-m4.mjs --api https://api.staging.example.org
 *
 * Exit codes: 0 the cycle completed, landed pending, and was torn down · 1 any phase failed ·
 * 2 the run could not be made (refused, or a programmer error).
 */
import { writeFileSync } from "node:fs";
import { normalizeBase } from "./m2-compliance/http.mjs";
import { runSubmissionCycle, teardown, verifyLandedPending } from "./m4-compliance/accept/flow.mjs";
import { parseArgs, productionWarning, refusals } from "./m4-compliance/accept/options.mjs";
import { Report } from "./m4-compliance/report.mjs";

const USAGE = `M4 write-acceptance — real 3-phase MCP submission, staging only

  RFPHUB_REVIEWER_TOKEN=<token> RFPHUB_WRITE_KEY=<rfph_key> node scripts/accept-m4.mjs --api <url>

THIS TOOL WRITES a real entry (title prefixed \`m4check-\`) to the deployment it is pointed at,
through the real MCP submit_opportunity interlock, including a simulated human approval step.
It tears the entry down (rejected + unlisted) at the end when the reviewer credential is available.

Required
  --api <url>              Origin of the deployed /v1/ API. Must look like staging or loopback
                           unless --allow-production is passed.
  RFPHUB_REVIEWER_TOKEN     A reviewer session, used only for teardown (reject + unlist).
  RFPHUB_WRITE_KEY          A write-scoped rfph_ key (write only, never publish — so the fixture
                           lands pending by construction, which is the property this tool proves).

Options
  --repo-root <path>       Repo checkout, for resolving packages/mcp/dist/cli.js. Default: cwd.
  --mcp-spec <spec>        npm version (or "next") to install via npx instead of the local build.
  --allow-production       Permit a target that does not look like staging or localhost. Prints a
                           red warning. There is no flag beyond this one — passing it IS the force.
  --keep-fixture           Do not reject/unlist the entry this run created. For debugging.
  --json <path>            Where to write the machine-readable report.
                           Default: m4-accept-report.json. Use "-" for stdout.
  --timeout <ms>           Per-request/process timeout. Default: 20000.
  --no-color               Plain output.
  -h, --help               This text.
`;

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

  const reasons = refusals(opts);
  if (reasons.length > 0) {
    process.stderr.write(
      `accept-m4 refuses to run:\n${reasons.map((r) => `  • ${r}`).join("\n")}\n\n${USAGE}`,
    );
    return 2;
  }
  try {
    opts.api = normalizeBase(opts.api, "--api");
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.allowProduction) {
    process.stderr.write(`${productionWarning(opts.api)}\n`);
  }

  const ctx = {
    ...opts,
    // m3-compliance/client.mjs (reused for the /v1/me/opportunities and reject calls) reads
    // ctx.baseUrl; this tool's own flag is --api, so it is aliased rather than renamed everywhere.
    baseUrl: opts.api,
  };
  const state = {
    run: new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "")
      .slice(0, 13),
  };

  const report = new Report({
    siteUrl: "(n/a — write acceptance targets the API only)",
    baseUrl: ctx.api,
    node: process.version,
  });

  const c = report.criterion(
    "M4-ACCEPT",
    "Real 3-phase MCP submission interlock",
    "preview → out-of-band approval → commit lands a fixture pending, verified via /v1/me/opportunities, then torn down.",
  );

  try {
    c.info("MCP server under test", "resolved at run time — see the next check's detail");
    const { approvalId, opportunityId } = await runSubmissionCycle(ctx, state);
    c.pass(
      "preview → approve → commit completes",
      `approvalId=${approvalId}, opportunityId=${opportunityId}`,
    );

    const entry = await verifyLandedPending(ctx, opportunityId);
    c.expect(
      entry.reviewStatus === "pending",
      "the fixture landed pending, verified via GET /v1/me/opportunities",
      `reviewStatus=${entry.reviewStatus}`,
      `reviewStatus=${entry.reviewStatus}, expected "pending"`,
    );
  } catch (err) {
    c.fail("preview → approve → commit completes", err.message);
  } finally {
    if (opts.keepFixture) {
      c.skip(
        "teardown",
        `--keep-fixture: leaving ${state.opportunityId ?? "(nothing created)"} in place`,
      );
    } else if (!state.opportunityId) {
      c.skip("teardown", "no fixture was created — nothing to tear down");
    } else {
      try {
        await teardown(ctx, state.opportunityId);
        c.pass("teardown", `${state.opportunityId} rejected and unlisted`);
      } catch (err) {
        c.warn("teardown", err.message);
      }
    }
  }
  c.finish();

  process.stdout.write(`${report.render({ color: opts.color })}\n`);

  const serialized = `${JSON.stringify(report.toJSON(), null, 2)}\n`;
  if (opts.json === "-") {
    process.stdout.write(serialized);
  } else {
    writeFileSync(opts.json, serialized);
    process.stdout.write(`\nJSON report written to ${opts.json}\n`);
  }

  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`m4-accept: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
