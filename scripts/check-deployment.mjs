#!/usr/bin/env node
/**
 * Read-only compliance check for a deployment.
 *
 * It fetches public documents and holds them to the contract they publish, so running it anywhere
 * costs nothing — which is why its defaults point at production. It cannot write: no credential
 * flag, no environment fallback, no code path that submits. That separation is the safety property,
 * not a convention — see ./compliance/README.md.
 *
 * Usage:
 *   node scripts/check-deployment.mjs --milestone m2 --api https://api.example.org \
 *     --export-url https://data.example.org
 *
 * Exit codes: 0 every selected criterion exercised and held · 1 a criterion failed, or a required
 * check was never exercised · 2 the run could not be made.
 */
import { writeFileSync } from "node:fs";
import {
  READ_CRITERIA,
  READ_MILESTONES,
  contractIds,
  criterionKeys,
  selectCriteria,
  selectionRefusals,
} from "./compliance/criteria.mjs";
import { normalizeBase } from "./compliance/http.mjs";
import {
  describeScope,
  keyList,
  parseArgs,
  refusals,
  selectionLine,
} from "./compliance/options.mjs";
import { Report } from "./compliance/report.mjs";
import { loadStandardValidator } from "./compliance/schema.mjs";

const USAGE = `RFP Hub — read-only deployment compliance check

  node scripts/check-deployment.mjs [options]                     (pnpm check:deployment)

Selection
  --milestone <id>        Run the criteria a contract milestone maps to, and stamp the mapping into
                          the header and into the JSON as criteria[].contractId. Known here:
                          ${Object.keys(READ_MILESTONES).join(", ")}. Not combinable with --only/--skip.
  --only <key>            Repeatable. Excluded criteria are not registered at all, so a green
                          scoped run is a clean pass. A hard prerequisite is added and announced.
  --skip <key>            Repeatable. Registers the criterion as unmet, which makes the run
                          INCOMPLETE. Refused together with --only.
                          Keys: ${keyList(criterionKeys(READ_CRITERIA))}
  (nothing)               Every registered read criterion runs, under its capability key.

Targets
  --api <url>             Origin of the deployed /v1/ API. Default https://api.ethrfps.app.
  --base-url <url>        Accepted alias for --api.
  --site <url>            Reference frontend. Default https://ethrfps.app.
  --export-url <url>      Root the open-data export is published under; latest.json, latest.csv,
                          latest.manifest.json and LICENSE are read directly beneath it. No
                          default, and required when the export criterion runs.
  --repo-root <path>      Checkout to read docs, skills and manifests from. Default: cwd.

Behavior
  --browser               Drive a real browser where a criterion needs rendered output.
  --offline               Skip anything that leaves the machine.
  --expect-indexable      Hold the site to being indexable rather than to carrying noindex.
  --mcp-spec <spec>       Which published MCP artifact to exercise.
  --min-total <n>         Dataset floor for /v1/stats and the export. Default: 100.
  --freshness-hours <n>   How old the export may be. Default: 24.
  --max-details <n>       Cap on documents fetched from the detail endpoint and validated against
                          the Standard. Default: 0, which means every one of them.
  --export-sample <n>     Documents sampled from the export for validation. 0 validates all of it.
                          Default: 25.
  --concurrency <n>       Requests in flight. Default: 6.
  --timeout <ms>          Per-request timeout. Default: 15000.
  --allow-insecure        Permit a plaintext http:// target on a non-loopback host. Loopback is
                          always allowed; anything else is a finding, not a default.
  --no-color              Plain output.
  --json <path>           Where to write the machine-readable report. Default: a unique file under
                          the system temporary directory, named on the last line of the run.
                          Use "-" for stdout.
  -h, --help              This text.

This tool has no credential flag, no credential environment fallback and no production override,
because it does not write. For the criteria that do, see \`pnpm accept:writes --help\`.
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

  const reasons = [
    ...refusals(opts),
    ...selectionRefusals(READ_CRITERIA, { only: opts.only, skip: opts.skip }),
  ];
  if (reasons.length > 0) {
    process.stderr.write(
      `check-deployment refuses to run:\n${reasons.map((r) => `  • ${r}`).join("\n")}\n`,
    );
    return 2;
  }

  try {
    opts.api = normalizeBase(opts.api, "--api");
    if (opts.exportUrl) opts.exportUrl = normalizeBase(opts.exportUrl, "--export-url");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const selection = selectCriteria(READ_CRITERIA, {
    only: opts.only,
    skip: opts.skip,
    profile: opts.milestone ? READ_MILESTONES[opts.milestone] : undefined,
  });

  // `--offline` is a promise, not a hint: a criterion that reads the deployment cannot keep it, so
  // only one whose meta declares `offline: true` survives the flag. The rest are unmet, not run.
  const reachable = opts.offline
    ? selection.criteria.filter((c) => c.meta.offline === true)
    : selection.criteria;
  const grounded = selection.criteria.filter((c) => !reachable.includes(c));

  // Up front, not per criterion: a run that cannot validate anything must not start and report.
  let standard;
  if (reachable.some((c) => c.meta.needs.includes("standard"))) {
    try {
      standard = await loadStandardValidator();
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
  }

  const needs = (name) => reachable.some((c) => c.meta.needs.includes(name));
  const report = new Report({
    title: "RFP Hub — deployment compliance check",
    milestone: opts.milestone,
    selection: selectionLine(opts, selection.autoIncluded),
    scopeLabel: describeScope(opts),
    contractIds: opts.milestone ? contractIds(READ_CRITERIA, opts.milestone) : undefined,
    api: opts.api,
    ...(needs("site") ? { site: opts.site } : {}),
    ...(needs("exportUrl") ? { exportUrl: opts.exportUrl } : {}),
    ...(needs("repoRoot") ? { repoRoot: opts.repoRoot } : {}),
    ...(standard ? { specVersion: standard.specVersion } : {}),
    browser: opts.browser,
    offline: opts.offline,
    node: process.version,
  });

  const ctx = { ...opts, report, results: {}, standard };
  for (const criterion of reachable) await criterion.run(ctx);
  for (const criterion of grounded) {
    const key = criterion.meta.key;
    report
      .criterion(
        key,
        key,
        "Not performed: this criterion reads the deployment, and --offline was passed.",
      )
      .unmet("skipped: --offline", `${key} reads the deployment over the network`)
      .finish();
  }
  for (const criterion of selection.skipped) {
    const key = criterion.meta.key;
    report
      .criterion(key, key, "Not performed: excluded from this run with --skip.")
      .unmet(`skipped: --skip ${key}`, "excluded by the caller")
      .finish();
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
    process.stderr.write(`check-deployment: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
