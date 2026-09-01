#!/usr/bin/env node
/**
 * M4 write-acceptance — the real 3-phase MCP submission interlock, driven end to end.
 *
 * `check-m4.mjs` is entirely read-only, including its MCP check: the one case that looks like a
 * write (`submit_opportunity` with the fail-closed env) runs against a LOCAL mock server, never
 * against a real deployment. This tool is the other half — it drives the actual interlock against
 * a real, writable STAGING deployment:
 *
 *   0. snapshot  `GET /v1/me/opportunities`, so "the preview created nothing" is a fact
 *   1. preview   `submit_opportunity` phase 1 — exact `status: "pending"`, snapshot unchanged
 *   2. refuse    phase 3 WITHOUT an approval — must be refused, snapshot still unchanged
 *   3. approve   a SEPARATE process runs `rfphub-mcp approve <approvalId>`. Driven
 *                non-interactively by default and reported as `approval: SIMULATED`;
 *                `--interactive-approval` waits for a person and reports `approval: HUMAN`
 *   4. commit    `submit_opportunity` phase 3 — the actual `POST`, now that an approval exists
 *
 * ...then verifies the fixture landed `pending` via `GET /v1/me/opportunities` (never the public
 * read surface, which hides pending entries by design), and tears it down — rejected and unlisted
 * by a reviewer — the same as `m3-compliance/cleanup.mjs`.
 *
 * THERE IS NO FLAG TO FORCE PRODUCTION. The target guard is default-deny against an explicit
 * allowlist of this project's staging origins plus loopback, https required off loopback, and the
 * redirect chain `--api` answers with is followed before the first write — a staging-looking CNAME
 * pointed at production passes every hostname rule there is.
 *
 * Usage:
 *   RFPHUB_REVIEWER_TOKEN=... RFPHUB_WRITE_KEY=rfph_... \
 *     node scripts/accept-m4.mjs --api https://api.staging.example.org
 *
 * Exit codes: 0 the cycle completed, landed pending, AND was torn down · 1 any phase failed, OR
 * teardown itself failed, OR `--keep-fixture` deliberately left a fixture behind (teardown is its
 * own criterion — see below — so a run that leaves a fixture in place is never reported as a
 * clean pass) · 2 the run could not be made (refused, or a programmer error).
 */
import { writeFileSync } from "node:fs";
import { normalizeBase } from "./m2-compliance/http.mjs";
import {
  runSubmissionCycle,
  runToken,
  teardown,
  verifyLandedPending,
  verifyTornDown,
} from "./m4-compliance/accept/flow.mjs";
import { parseArgs, redirectRefusal, refusals } from "./m4-compliance/accept/options.mjs";
import { Report } from "./m4-compliance/report.mjs";

const USAGE = `M4 write-acceptance — real 3-phase MCP submission, staging only

  RFPHUB_REVIEWER_TOKEN=<token> RFPHUB_WRITE_KEY=<rfph_key> node scripts/accept-m4.mjs --api <url>

THIS TOOL WRITES a real entry (title prefixed \`m4check-\`) to the deployment it is pointed at,
through the real MCP submit_opportunity interlock. The approval step is DRIVEN, not human, unless
--interactive-approval is passed; the report says which. It tears the entry down (rejected and
unlisted, then verified gone from the owner listing and the public route) at the end.

Required
  --api <url>              Origin of the deployed /v1/ API. Loopback, or one of this project's
                           staging origins. There is no flag to force production; add another
                           staging origin with RFPHUB_ACCEPT_EXTRA_STAGING_ORIGIN.
  RFPHUB_REVIEWER_TOKEN     A reviewer session, used only for teardown (reject + unlist).
  RFPHUB_WRITE_KEY          A write-scoped rfph_ key (write only, never publish — so the fixture
                           lands pending by construction, which is the property this tool proves).

Options
  --repo-root <path>       Repo checkout, for resolving packages/mcp/dist/cli.js. Default: cwd.
  --mcp-spec <spec>        npm version for npx (default "next" — the real registry package).
                           Pass "local" for packages/mcp/dist/cli.js instead, to drive this against
                           a pre-publish build.
  --interactive-approval   Pause at phase 2 and print the exact \`rfphub-mcp approve <id>\` command
                           for a HUMAN to run in another terminal, then wait for it. Without it
                           the CLI is driven non-interactively and the report says plainly that
                           the approval was SIMULATED.
  --keep-fixture           Do not reject/unlist the entry this run created. For debugging.
  --json <path>            Where to write the machine-readable report.
                           Default: m4-accept-report-<pid>-<timestamp>.json, printed after the
                           run. Use "-" for stdout.
  --timeout <ms>           Per-request/process timeout. Default: 20000.
  --approve-timeout <ms>   How long phase 2 may take. Default: 15000 (raised automatically with
                           --interactive-approval, which waits on a person).
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
  const redirect = await redirectRefusal(opts.api, { timeoutMs: opts.timeoutMs });
  if (redirect) {
    process.stderr.write(`accept-m4 refuses to run:\n  \u2022 ${redirect}\n`);
    return 2;
  }

  const ctx = {
    ...opts,
    // m3-compliance/client.mjs (reused for the /v1/me/opportunities and reject calls) reads
    // ctx.baseUrl; this tool's own flag is --api, so it is aliased rather than renamed everywhere.
    baseUrl: opts.api,
  };
  const state = { run: runToken() };

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
  // A SEPARATE criterion, on purpose — the same reasoning as `m3-compliance/cleanup.mjs`'s own
  // "M3-T" criterion. If teardown were just another CHECK inside "M4-ACCEPT", a `--keep-fixture`
  // run would still be reported PASS: `Criterion.status` is only SKIP when EVERY check in it is
  // skip/info, and the submission-cycle checks above it would still have passed. Making teardown
  // its own criterion means a `--keep-fixture` run (or one where nothing to tear down was ever
  // established) makes THIS criterion SKIP, which makes the overall run `incomplete` — not green,
  // and not exit 0 — exactly the property "a run that deliberately leaves a fixture behind must
  // not report success" needs.
  const t = report.criterion(
    "M4-ACCEPT-T",
    "Fixture teardown",
    "The fixture this run created is rejected and unlisted. A hygiene criterion, reported at the same level as the submission cycle on purpose, so --keep-fixture (or a teardown failure) cannot be green.",
  );

  try {
    const opportunityId = await runSubmissionCycle(ctx, state, c);

    const entry = await verifyLandedPending(ctx, opportunityId);
    c.expect(
      entry.reviewStatus === "pending",
      "the fixture landed pending, verified via GET /v1/me/opportunities",
      `reviewStatus=${entry.reviewStatus}`,
      `reviewStatus=${entry.reviewStatus}, expected "pending"`,
    );
  } catch (err) {
    // `state.commitAttempted` is set immediately before the phase-3 POST — once true, a throw does
    // NOT mean "nothing was created": the request may have reached the API even though this process
    // never saw the reply. `state.candidateOpportunityId` is the id the document itself declared,
    // known since before phase 1, which is exactly what lets this recover and still tear down.
    if (state.commitAttempted && state.candidateOpportunityId) {
      c.fail(
        "preview → out-of-band approval → commit completes",
        `${err.message} — the outcome is AMBIGUOUS (the POST may have reached the API even though this call did not return); checking /v1/me/opportunities for ${state.candidateOpportunityId}`,
      );
      try {
        const entry = await verifyLandedPending(ctx, state.candidateOpportunityId);
        state.opportunityId = state.candidateOpportunityId;
        c.warn(
          "ambiguous commit actually landed",
          `${state.candidateOpportunityId} is present with reviewStatus=${entry.reviewStatus} despite the error above — tearing it down`,
        );
      } catch (verifyErr) {
        c.info(
          "ambiguous commit verification",
          `${state.candidateOpportunityId} not found via /v1/me/opportunities either (${verifyErr.message}) — most likely the write genuinely did not land, but this is not certain`,
        );
      }
    } else {
      c.fail("preview → out-of-band approval → commit completes", err.message);
    }
  } finally {
    c.info("approval mode", state.approvalMode ?? "(never reached)");
    c.finish();
    if (opts.keepFixture) {
      t.skip(
        "teardown",
        `--keep-fixture: leaving ${state.opportunityId ?? "(nothing created)"} in place`,
      );
    } else if (!state.opportunityId) {
      t.skip("teardown", "no fixture was created — nothing to tear down");
    } else {
      try {
        await teardown(ctx, state.opportunityId);
        // A 200 from the reject endpoint is not the same fact as "the entry is gone from every
        // surface a reader can reach", which is what teardown is for.
        const gone = await verifyTornDown(ctx, state.opportunityId);
        t.expect(
          gone.ok,
          "teardown",
          `${state.opportunityId} rejected; owner listing shows ${gone.ownerStatus} and the public route answers ${gone.publicStatus}`,
          `${state.opportunityId} was rejected but is still reachable: owner listing shows ${gone.ownerStatus}, the public route answers ${gone.publicStatus} — REJECT/UNLIST IT BY HAND`,
        );
      } catch (err) {
        // A teardown failure leaves a real entry behind in the deployment this tool just wrote to.
        // That is a FAILED run, not a warning on an otherwise-green one.
        t.fail("teardown", err.message);
      }
    }
    t.finish();
  }

  process.stdout.write(`${report.render({ color: opts.color })}\n`);

  const serialized = `${JSON.stringify(report.toJSON(), null, 2)}\n`;
  const jsonPath =
    opts.json ??
    `m4-accept-report-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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
    process.stderr.write(`m4-accept: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
