#!/usr/bin/env node
/**
 * M3 sign-off compliance checker.
 *
 * Mechanically verifies the M3 completion criteria against a LIVE deployment:
 *
 *   1. Publisher lifecycle    identity resolves, a scoped key is minted, an entry is submitted
 *                             through the API and then replaced through it
 *   2. Namespace queue        a submission into a namespace the credential does not hold is
 *                             accepted, lands pending, and is not publicly readable
 *   3. Audit trail            every mutation recorded with its action, actor and timestamp; the
 *                             public view redacted to field names, the owner's not
 *   4. Duplicate detection    a reworded resubmission surfaces the original — or says honestly,
 *                             through `duplicateCheck`, that detection did not run
 *   5. Verification           an entry with an applicationUrl produces a recorded run carrying a
 *                             snapshot digest, and the entry's own flag agrees with it
 *   6. Analytics              real reads and link-outs are counted and served back to the
 *                             publisher the same day, before any rollup
 *   7. Staleness              an entry whose fixed deadline has passed is closed by the job, with
 *                             the reason and the actor recorded
 *
 * HOW THIS DIFFERS FROM `check-m2.mjs`, and why it is stricter about being allowed to run.
 * check-m2 is a read-only probe: it fetches public documents and holds them to a published
 * contract, so running it anywhere, twice, costs nothing. **This one writes.** It submits entries,
 * mints a credential, generates analytics traffic and asks a reviewer to close things. So it
 * refuses to start without credentials and a namespace, and refuses a target that does not look
 * like staging unless `--allow-production` is passed in those words.
 *
 * It is NOT wired into CI, deliberately. CI has no deployment to write to, and a sign-off tool that
 * needed a standing publisher credential in repository secrets would be a worse thing to have than
 * a tool somebody runs.
 *
 * Usage:
 *   node scripts/check-m3.mjs --base-url https://api.staging.example.org \
 *     --namespace my-org --session-token "$TOKEN"
 *
 * Exit codes: 0 every criterion exercised and held · 1 a criterion failed, or one was never
 * exercised (the run does not establish the milestone) · 2 the run could not be made.
 */
import { writeFileSync } from "node:fs";
import { normalizeBase } from "./compliance/client.mjs";
import { TEARDOWN, WRITE_CRITERIA, selectCriteria } from "./compliance/criteria.mjs";
import { runStamp } from "./compliance/fixtures.mjs";
import { parseArgs, refusals } from "./compliance/options.mjs";
import { Report } from "./compliance/report.mjs";

const USAGE = `M3 sign-off compliance checker

  node scripts/check-m3.mjs --base-url <url> --namespace <slug> (--session-token <t> | --api-key <k>)

THIS TOOL WRITES to the deployment it is pointed at: it submits entries, mints an API key and
generates analytics traffic. Everything it creates is prefixed \`compliance-\` and is rejected and
unlisted at the end when a reviewer credential is available.

Required
  --base-url <url>        Origin of the deployed /v1/ API.
  --namespace <slug>      The namespace fixtures are created in. Lowercase, hyphenated.
  --session-token <token> A signed-in session. Needed for key minting and for the session-only
                          surfaces; strongly preferred.
  --api-key <key>         An \`rfph_\` key, as an alternative. Criteria that require a session
                          report SKIP rather than pass.

Options
  --admin-token <token>   An administrator session. Without it the staleness criterion cannot start
                          the job on demand and reports SKIP, and fixtures cannot be rejected.
  --application-url <url> The applicationUrl the fixtures carry. Defaults to the deployment's own
                          /v1/docs, which is always reachable; point it at a real HTML page to
                          exercise the verification snapshot digest end to end.
  --allow-production      Permit a target that does not look like staging or localhost. Required,
                          in these words, because this tool writes.
  --keep-fixtures         Do not reject the entries this run created. For debugging a failed run.
  --views <n>             Detail reads generated for the analytics criterion. Default 5.
  --json <path>           Where to write the machine-readable report.
                          Default: m3-compliance-report.json. Use "-" for stdout.
  --concurrency <n>       Requests in flight. Default 4.
  --timeout <ms>          Per-request timeout. Default 20000.
  --no-color              Plain output.
  -h, --help              This text.

Credentials may also arrive as M3_SESSION_TOKEN / M3_ADMIN_TOKEN / M3_API_KEY, which keeps them off
the command line \`ps\` prints. The flags win wherever both are present.
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
      `check-m3 refuses to run:\n${reasons.map((r) => `  • ${r}`).join("\n")}\n\n${USAGE}`,
    );
    return 2;
  }
  try {
    opts.baseUrl = normalizeBase(opts.baseUrl, "--base-url");
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const ctx = {
    ...opts,
    api: opts.baseUrl,
    // The credential the read-and-own checks use. A session where one exists, because it is the
    // account acting directly rather than a scoped delegation of it.
    credential: opts.sessionToken ?? opts.apiKey,
  };
  const state = { run: runStamp(), fixtureIds: [] };

  const report = new Report({
    title: "RFP Hub — M3 sign-off compliance check",
    api: ctx.api,
    namespace: ctx.namespace,
    fixturePrefix: `${ctx.namespace}:compliance-${state.run}-`,
    credentialKind: opts.sessionToken ? "session" : "api-key",
    adminToken: Boolean(opts.adminToken),
    views: ctx.views,
    node: process.version,
  });

  ctx.report = report;
  ctx.results = {};
  ctx.state = state;
  try {
    for (const criterion of selectCriteria(WRITE_CRITERIA).criteria) await criterion.run(ctx);
  } finally {
    // Runs whatever happened above. A teardown skipped because a criterion threw would leave rows
    // in somebody's deployment and say nothing about it.
    await TEARDOWN.run(ctx);
  }

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
    process.stderr.write(`m3-compliance: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
