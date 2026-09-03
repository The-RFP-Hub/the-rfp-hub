#!/usr/bin/env node
/**
 * Write acceptance against a staging deployment.
 *
 * THIS TOOL WRITES to whatever it is pointed at: it submits entries, mints a credential, generates
 * analytics traffic and asks a reviewer to close things. So, unlike `check-deployment.mjs`, it has
 * no default target, refuses anything outside the staging allowlist, and refuses to start without
 * the reviewer credential its teardown needs.
 *
 * What it produces is an ACCEPTANCE report, never a deployment sign-off: it exercises behavior a
 * read-only probe cannot reach, and the report says so in its headline and in `signOff: false`.
 *
 * It is NOT wired into CI, deliberately. CI has no deployment to write to, and a tool that needed a
 * standing publisher credential in repository secrets would be a worse thing to have than a tool
 * somebody runs.
 *
 * Usage:
 *   node scripts/accept-writes.mjs --milestone m3 --api https://api-staging.example.org \
 *     --namespace my-org --session-token "$SESSION" --admin-token "$ADMIN"
 *
 * Exit codes: 0 every selected criterion exercised and held · 1 a criterion failed, or a required
 * check was never exercised · 2 the run could not be made.
 */
import { writeFileSync } from "node:fs";
import { parseArgs, refusals } from "./compliance/accept-options.mjs";
import { normalizeBase } from "./compliance/client.mjs";
import {
  TEARDOWN,
  WRITE_CRITERIA,
  WRITE_MILESTONES,
  contractIds,
  criterionKeys,
  selectCriteria,
  selectionRefusals,
} from "./compliance/criteria.mjs";
import { runStamp } from "./compliance/fixtures.mjs";
import { selectionLine } from "./compliance/options.mjs";
import { acceptanceReport } from "./compliance/report.mjs";
import { EXTRA_ORIGIN_ENV, STAGING_ORIGINS, redirectRefusal } from "./compliance/target-guard.mjs";

const USAGE = `RFP Hub — write acceptance (staging only)

  node scripts/accept-writes.mjs --milestone m3 --api <url> --namespace <slug> \\
    (--session-token <t> | --api-key <k>) --admin-token <t>          (pnpm accept:writes)

THIS TOOL WRITES to the deployment it is pointed at. Everything it creates is prefixed
\`compliance-\` and is rejected and unlisted at the end. The report is labeled
"write acceptance — NOT a deployment sign-off", and signOff is always false.

Target guard — there is no flag that forces production
  Loopback, or https to ${STAGING_ORIGINS.join(" / ")}, or one extra https origin whose hostname
  carries a "staging" label and no "prod" label, named by ${EXTRA_ORIGIN_ENV}. The redirect chain
  the target answers with is re-checked to 5 hops and must also end inside the allowlist.

Required
  --milestone <id>        Which acceptance profile to run. Known here: ${Object.keys(WRITE_MILESTONES).join(", ")}.
  --api <url>             Origin of the deployed /v1/ API. --base-url is an accepted alias.
  --namespace <slug>      The namespace fixtures are created in. Lowercase, hyphenated.
  --session-token <token> A signed-in session. Needed for key minting and for the session-only
                          surfaces; strongly preferred over --api-key.
  --api-key <key>         An \`rfph_\` key, as an alternative. Criteria that require a session
                          report a skip rather than a pass.
  --admin-token <token>   An administrator session, unless --session-token is itself a reviewer.
                          Required: the teardown rejects and unlists with it.

Options
  --only <key>            Repeatable. Narrows the profile to those criteria. A hard prerequisite is
                          added and announced — --only audit on its own could only report that it
                          had no fixture to read. Refused together with --skip.
  --skip <key>            Repeatable. Registers the criterion as unmet, which makes the run
                          INCOMPLETE. Refused if a selected criterion depends on it.
                          Keys: ${criterionKeys(WRITE_CRITERIA).join(" ")}
  --application-url <url> The applicationUrl the fixtures carry. Defaults to the deployment's own
                          /v1/docs, which is always reachable; point it at a real HTML page to
                          exercise the verification snapshot digest end to end.
  --views <n>             Detail reads generated for the analytics criterion. Default 5.
  --keep-fixtures         Do not reject the entries this run created. For debugging a failed run.
                          The run then reports INCOMPLETE, because it left rows behind.
  --json <path>           Where to write the machine-readable report. Default: a unique file under
                          the system temporary directory, named on the last line of the run.
                          Use "-" for stdout.
  --concurrency <n>       Requests in flight. Default 4.
  --timeout <ms>          Per-request timeout. Default 20000.
  --no-color              Plain output.
  -h, --help              This text.

Credentials may also arrive as COMPLIANCE_SESSION_TOKEN / COMPLIANCE_ADMIN_TOKEN /
COMPLIANCE_API_KEY, which keeps them off the command line \`ps\` prints. The flags win.
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

  // Every refusal is decided before a single request is made, so a run that must not happen costs
  // the deployment nothing at all.
  const reasons = [
    ...refusals(opts, WRITE_MILESTONES),
    ...selectionRefusals(WRITE_CRITERIA, { only: opts.only, skip: opts.skip }),
  ];
  if (reasons.length > 0) {
    process.stderr.write(
      `accept-writes refuses to run:\n${reasons.map((r) => `  • ${r}`).join("\n")}\n`,
    );
    return 2;
  }

  try {
    opts.api = normalizeBase(opts.api, "--api");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const redirect = await redirectRefusal(opts.api, { timeoutMs: opts.timeoutMs });
  if (redirect) {
    process.stderr.write(`accept-writes refuses to run:\n  • ${redirect}\n`);
    return 2;
  }

  const selection = selectCriteria(WRITE_CRITERIA, {
    only: opts.only,
    skip: opts.skip,
    profile: opts.only.size > 0 ? undefined : WRITE_MILESTONES[opts.milestone],
  });

  const state = { run: runStamp(), fixtureIds: [] };
  const report = acceptanceReport({
    title: "RFP Hub — write acceptance",
    milestone: opts.milestone,
    selection: selectionLine(opts, selection.autoIncluded),
    contractIds: contractIds(WRITE_CRITERIA, opts.milestone),
    api: opts.api,
    namespace: opts.namespace,
    fixturePrefix: `${opts.namespace}:compliance-${state.run}-`,
    credentialKind: opts.sessionToken ? "session" : "api-key",
    adminToken: Boolean(opts.adminToken),
    views: opts.views,
    node: process.version,
  });

  const ctx = {
    ...opts,
    // The credential the read-and-own checks use. A session where one exists, because it is the
    // account acting directly rather than a scoped delegation of it.
    credential: opts.sessionToken ?? opts.apiKey,
    report,
    results: {},
    state,
  };

  try {
    for (const criterion of selection.criteria) await criterion.run(ctx);
    for (const criterion of selection.skipped) {
      const key = criterion.meta.key;
      report
        .criterion(key, key, "Not performed: excluded from this run with --skip.")
        .unmet(key, `--skip ${key}`)
        .finish();
    }
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
    process.stderr.write(`accept-writes: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
