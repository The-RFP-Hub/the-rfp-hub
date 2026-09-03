#!/usr/bin/env node
/**
 * M2 sign-off compliance checker.
 *
 * Mechanically verifies the four M2 completion criteria against a LIVE deployment:
 *
 *   1. API liveness          {base}/v1/health is 200 and healthy, over valid TLS, timed
 *   2. OpenAPI conformance   every operation in the PUBLISHED document, executed against the live
 *                            service and held to its own declared status/media type/schema, plus
 *                            the strict-query negative contract
 *   3. Dataset               >= the floor, pages consistently, EVERY served document validates
 *                            against the Standard, filtered counts agree with the aggregate
 *   4. Export freshness      latest.json + latest.csv download, parse, validate, carry CC0, are
 *                            inside the freshness window, and describe the same DATASET — and,
 *                            where a manifest is published, the same verified RUN
 *
 * Everything is parameterized: nothing about any particular host, domain or dataset size is baked
 * in beyond the floors the milestone itself states, which are flags with those floors as defaults.
 * That is what lets the same tool be run against a local instance today and against the deployment
 * on the day it exists.
 *
 * Usage:
 *   node scripts/check-m2.mjs --base-url https://api.example.org --export-url https://data.example.org
 *
 * Exit codes: 0 all criteria pass · 1 at least one criterion failed or could not be exercised ·
 * 2 the run could not be made.
 */
import { writeFileSync } from "node:fs";
import { checkDataset } from "./compliance/checks/dataset.mjs";
import { checkExport } from "./compliance/checks/export.mjs";
import { checkLiveness } from "./compliance/checks/liveness.mjs";
import { checkOpenApi } from "./compliance/checks/openapi.mjs";
import { normalizeBase } from "./compliance/http.mjs";
import { Report } from "./compliance/report.mjs";
import { loadStandardValidator } from "./compliance/schema.mjs";

const USAGE = `M2 sign-off compliance checker

  node scripts/check-m2.mjs --base-url <url> --export-url <url> [options]

Required
  --base-url <url>        Origin of the deployed /v1/ API (e.g. https://api.example.org).
  --export-url <url>      Root the open-data export is published under; latest.json,
                          latest.csv, latest.manifest.json and LICENSE are read directly
                          beneath it.

Options
  --json <path>           Where to write the machine-readable report.
                          Default: m2-compliance-report.json. Use "-" for stdout.
  --min-total <n>         Dataset floor for /v1/stats and the export. Default: 100.
  --freshness-hours <n>   How old the export may be. Default: 24.
  --max-details <n>       Cap on documents fetched from the detail endpoint and validated
                          against the Standard. Default: 0 (every one of them, which is
                          what a sign-off run wants).
  --export-sample <n>     Documents sampled from the export for validation. 0 validates the
                          whole file. Default: 25.
  --concurrency <n>       Requests in flight. Default: 8.
  --timeout <ms>          Per-request timeout. Default: 15000.
  --allow-insecure        Permit a plaintext http:// base URL on a non-loopback host. Loopback
                          is always allowed; anything else is a finding, not a default.
  --no-color              Plain output.
  -h, --help              This text.
`;

const DEFAULTS = {
  json: "m2-compliance-report.json",
  minTotal: 100,
  freshnessHours: 24,
  maxDetails: 0,
  exportSample: 25,
  concurrency: 8,
  timeoutMs: 15000,
  allowInsecure: false,
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const number = (raw, flag) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${flag} must be a non-negative number, got "${raw}"`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--export-url":
        opts.exportUrl = next();
        break;
      case "--json":
        opts.json = next();
        break;
      case "--min-total":
        opts.minTotal = number(next(), arg);
        break;
      case "--freshness-hours":
        opts.freshnessHours = number(next(), arg);
        break;
      case "--max-details":
        opts.maxDetails = number(next(), arg);
        break;
      case "--export-sample":
        opts.exportSample = number(next(), arg);
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, number(next(), arg));
        break;
      case "--timeout":
        opts.timeoutMs = number(next(), arg);
        break;
      case "--allow-insecure":
        opts.allowInsecure = true;
        break;
      case "--no-color":
        opts.color = false;
        break;
      default:
        throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    opts.baseUrl = normalizeBase(opts.baseUrl, "--base-url");
    opts.exportUrl = normalizeBase(opts.exportUrl, "--export-url");
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  // The Standard validator is loaded up front: without it criterion 3 and criterion 4 cannot be
  // performed at all, and a run that cannot perform half its criteria must not start and report.
  let standard;
  try {
    standard = await loadStandardValidator();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const ctx = { ...opts, api: opts.baseUrl };
  const report = new Report({
    title: "RFP Hub — M2 sign-off compliance check",
    api: opts.baseUrl,
    exportUrl: opts.exportUrl,
    specVersion: standard.specVersion,
    minTotal: opts.minTotal,
    freshnessHours: opts.freshnessHours,
    maxDetails: opts.maxDetails,
    exportSample: opts.exportSample,
    node: process.version,
  });

  await checkLiveness(report, ctx);
  const { doc, bundle } = await checkOpenApi(report, ctx);
  await checkDataset(report, ctx, { doc, bundle, standard });
  await checkExport(report, ctx, { standard });

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
    process.stderr.write(`m2-compliance: unexpected failure — ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
