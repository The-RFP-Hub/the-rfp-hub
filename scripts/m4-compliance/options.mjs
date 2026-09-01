/**
 * Argument parsing for the M4 compliance checker.
 *
 * Unlike `m3-compliance/options.mjs`, THIS TOOL IS READ-ONLY: it never mints a key, never submits
 * an entry, never asks a reviewer to do anything. So there is no `--allow-production` and no
 * credential handling here — every default points at the live production deployment on purpose,
 * because reading it costs the deployment nothing and that is the whole value of a read-only
 * checker (same reasoning as `check-m2.mjs`).
 *
 * `--only` vs `--skip`: THEY MEAN DIFFERENT THINGS AND ARE NOT INTERCHANGEABLE. `--skip` still
 * REGISTERS the criterion — as a `skip` outcome — which is what makes `Report.result` correctly
 * report `incomplete` (and exit 1) for a run that only looked at part of the contract. `--only`
 * does not register the excluded criteria AT ALL, so a run scoped to one check that passes is a
 * clean PASS, exit 0. That distinction is exactly what the `docs-links` CI job needs: it runs only
 * the `docs` check, has no deployment to hold the other five against, and must not fail on
 * "incomplete" for work outside its own job's scope. The two flags are refused together, since
 * combining "only run X" with "explicitly skip Y" has no single sensible meaning.
 */

const CHECK_IDS = ["governance", "publishers", "frontend", "mcp", "skill", "docs"];

const NUMERIC = new Set(["--timeout", "--concurrency"]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;
const MCP_SPEC_HELP =
  'a dist-tag ("next"), an exact version ("0.1.0"), or "local"; a full "@the-rfp-hub/mcp@<x>" is accepted and normalized to "<x>"';

/**
 * Normalize `--mcp-spec` to what `npx -y @the-rfp-hub/mcp@<spec>` needs after it.
 *
 * The full-package form is accepted and stripped because the operator runbook spells it that way,
 * and concatenating it produced `@the-rfp-hub/mcp@@the-rfp-hub/mcp@next` — an npm ENOENT nobody
 * could read back to the flag. A range (`^1.0.0`, `1.x`, `*`) is refused rather than passed
 * through: this criterion is about ONE immutable published artifact, and a range does not name one.
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

export function parseArgs(argv) {
  const opts = {
    site: "https://ethrfps.app",
    api: "https://api.ethrfps.app",
    repoRoot: process.cwd(),
    json: undefined,
    skip: new Set(),
    only: new Set(),
    browser: false,
    offline: false,
    expectIndexable: false,
    mcpSpec: undefined,
    timeoutMs: 15000,
    concurrency: 6,
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

    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--site":
        opts.site = next();
        break;
      case "--api":
        opts.api = next();
        break;
      case "--repo-root":
        opts.repoRoot = next();
        break;
      case "--json":
        opts.json = next();
        break;
      case "--skip": {
        const value = next();
        if (!CHECK_IDS.includes(value)) {
          throw new Error(`--skip must be one of ${CHECK_IDS.join(", ")}, got "${value}"`);
        }
        opts.skip.add(value);
        break;
      }
      case "--only": {
        const value = next();
        if (!CHECK_IDS.includes(value)) {
          throw new Error(`--only must be one of ${CHECK_IDS.join(", ")}, got "${value}"`);
        }
        opts.only.add(value);
        break;
      }
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
      case "--timeout":
        opts.timeoutMs = number(next());
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, number(next()));
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

  return opts;
}

/**
 * What a scoped run answers, when it is not the whole question. A run narrowed by --only/--skip,
 * or one that did not make the docs criterion's requests at all, cannot be presented as an M4
 * sign-off, so its headline never renders the bare PASS that answer wears.
 */
export function describeScope(opts) {
  const parts = [];
  if (opts.only.size > 0) parts.push(`--only ${[...opts.only].join(", ")}`);
  if (opts.skip.size > 0) parts.push(`--skip ${[...opts.skip].join(", ")}`);
  if (opts.offline) parts.push("--offline");
  if (parts.length === 0) return undefined;
  const docsLint = opts.offline && opts.only.size === 1 && opts.only.has("docs");
  const what = docsLint ? "docs lint, offline" : parts.join(" ");
  return `${what} — NOT an M4 sign-off (${parts.join(" ")})`;
}

export { CHECK_IDS };
