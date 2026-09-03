/**
 * Argument parsing for `scripts/check-deployment.mjs`, which only READS.
 *
 * No credential flag and no credential environment fallback, deliberately: this tool defaults to
 * production, and what makes that safe is having no way to be handed something to write with.
 *
 * `--only` and `--skip` are NOT interchangeable. `--skip` still registers the criterion, as an
 * unmet one, so a partial run reports incomplete; `--only` does not register the excluded criteria
 * at all, which is what a scoped lint needs. Refused together: the combination has no one meaning.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_CRITERIA, READ_MILESTONES, criterionKeys } from "./criteria.mjs";

const NUMERIC = new Set([
  "--timeout",
  "--concurrency",
  "--min-total",
  "--freshness-hours",
  "--max-details",
  "--export-sample",
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;
const MCP_SPEC_HELP =
  'a dist-tag ("next"), an exact version ("0.1.0"), or "local"; a full "@the-rfp-hub/mcp@<x>" is accepted and normalized to "<x>"';

/**
 * Normalize `--mcp-spec` to what follows `npx -y @the-rfp-hub/mcp@`. The full-package form is
 * accepted and stripped because concatenating it produced `@the-rfp-hub/mcp@@the-rfp-hub/mcp@next`,
 * an npm ENOENT nobody could read back to the flag. A range is refused: this criterion is about one
 * immutable artifact, and a range does not name one.
 */
export function normalizeMcpSpec(raw) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`--mcp-spec needs a value — ${MCP_SPEC_HELP}`);
  const full = /^@the-rfp-hub\/mcp@(.*)$/.exec(value);
  const spec = (full ? full[1] : value).trim();
  if (spec === "local") return "local";
  if (EXACT_VERSION.test(spec) || DIST_TAG.test(spec)) return spec;
  throw new Error(`--mcp-spec must be ${MCP_SPEC_HELP}, got "${value}"`);
}

export function keyList(keys, width = 60, indent = " ".repeat(32)) {
  const lines = [];
  for (const key of keys) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]}, ${key}`.length <= width) lines[last] += `, ${key}`;
    else lines.push(key);
  }
  return lines.join(`,\n${indent}`);
}

export function defaultReportPath(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), `${prefix}-${process.pid}-${stamp}.json`);
}

export function parseArgs(argv) {
  const opts = {
    api: "https://api.ethrfps.app",
    site: "https://ethrfps.app",
    exportUrl: undefined,
    repoRoot: process.cwd(),
    milestone: undefined,
    only: new Set(),
    skip: new Set(),
    json: undefined,
    browser: false,
    offline: false,
    expectIndexable: false,
    mcpSpec: undefined,
    minTotal: 100,
    freshnessHours: 24,
    maxDetails: 0,
    exportSample: 25,
    concurrency: 6,
    timeoutMs: 15000,
    allowInsecure: false,
    help: false,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    const number = (raw) => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${arg} must be a non-negative number, got "${raw}"`);
      }
      return value;
    };
    const criterion = (flag) => {
      const value = next();
      const known = criterionKeys(READ_CRITERIA);
      if (!known.includes(value)) {
        throw new Error(`${flag} must be one of ${known.join(", ")}, got "${value}"`);
      }
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      // The name the M2 checker spelled, and the one every external sign-off recipe already
      // carries. Kept as an alias so those keep working across the rename.
      case "--base-url":
      case "--api":
        opts.api = next();
        break;
      case "--site":
        opts.site = next();
        break;
      case "--export-url":
        opts.exportUrl = next();
        break;
      case "--repo-root":
        opts.repoRoot = next();
        break;
      case "--milestone":
        opts.milestone = next().toLowerCase();
        break;
      case "--only":
        opts.only.add(criterion("--only"));
        break;
      case "--skip":
        opts.skip.add(criterion("--skip"));
        break;
      case "--json":
        opts.json = next();
        break;
      case "--browser":
        opts.browser = true;
        break;
      case "--offline":
        opts.offline = true;
        break;
      case "--expect-indexable":
        opts.expectIndexable = true;
        break;
      case "--mcp-spec":
        opts.mcpSpec = normalizeMcpSpec(next());
        break;
      case "--min-total":
        opts.minTotal = number(next());
        break;
      case "--freshness-hours":
        opts.freshnessHours = number(next());
        break;
      case "--max-details":
        opts.maxDetails = number(next());
        break;
      case "--export-sample":
        opts.exportSample = number(next());
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, number(next()));
        break;
      case "--timeout":
        opts.timeoutMs = number(next());
        break;
      case "--allow-insecure":
        opts.allowInsecure = true;
        break;
      case "--no-color":
        opts.color = false;
        break;
      default:
        throw new Error(
          NUMERIC.has(arg) ? `${arg} needs a value` : `unknown argument "${arg}" (try --help)`,
        );
    }
  }

  if (opts.only.size > 0 && opts.skip.size > 0) {
    throw new Error("--only and --skip cannot be combined — see the module docstring for why");
  }
  if (opts.json === undefined) opts.json = defaultReportPath("compliance-report");
  return opts;
}

/**
 * Everything that has to hold before a request is made. Empty means go. A milestone this binary
 * does not own is an error naming the tool that does, rather than an empty run.
 */
export function refusals(opts, milestones = READ_MILESTONES) {
  const reasons = [];
  if (opts.milestone !== undefined) {
    if (opts.only.size > 0 || opts.skip.size > 0) {
      reasons.push(
        "--milestone selects the criteria itself, so it cannot be combined with --only/--skip",
      );
    }
    if (opts.milestone === "m3") {
      reasons.push(
        "the M3 criteria write — run them with `pnpm accept:writes --milestone m3`, which holds the staging-only target guard",
      );
    } else if (!milestones[opts.milestone]) {
      reasons.push(
        `unknown milestone "${opts.milestone}" — this tool knows ${Object.keys(milestones).join(", ")}`,
      );
    }
  }
  if (reasons.length > 0) return reasons;

  const selected = opts.milestone
    ? milestones[opts.milestone]
    : opts.only.size > 0
      ? [...opts.only]
      : criterionKeys(READ_CRITERIA);
  if (selected.includes("export") && !opts.skip.has("export") && !opts.exportUrl) {
    reasons.push(
      "--export-url is required when the export criterion runs — it is the root latest.json, latest.csv and LICENSE are read beneath",
    );
  }
  return reasons;
}

export function selectionLine(opts, autoIncluded = []) {
  const parts = [];
  if (opts.only.size > 0) parts.push(`--only ${[...opts.only].join(", ")}`);
  if (opts.skip.size > 0) parts.push(`--skip ${[...opts.skip].join(", ")}`);
  if (parts.length === 0) return undefined;
  const added = autoIncluded.length > 0 ? `  (+ ${autoIncluded.join(", ")}, required)` : "";
  return `${parts.join(" ")}${added}`;
}

/** A run narrowed by --only/--skip/--offline answers a narrower question, and must say so. */
export function describeScope(opts) {
  const parts = [];
  if (opts.only.size > 0) parts.push(`--only ${[...opts.only].join(", ")}`);
  if (opts.skip.size > 0) parts.push(`--skip ${[...opts.skip].join(", ")}`);
  if (opts.offline) parts.push("--offline");
  if (parts.length === 0) return undefined;
  const docsLint = opts.offline && opts.only.size === 1 && opts.only.has("docs");
  const what = docsLint ? "docs lint, offline" : parts.join(" ");
  return `${what} — NOT a deployment sign-off (${parts.join(" ")})`;
}
