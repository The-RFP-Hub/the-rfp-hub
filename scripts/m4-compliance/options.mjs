/**
 * Argument parsing for the M4 compliance checker. This tool is read-only, so there is no
 * credential handling and no production opt-in: every default points at the live deployment.
 *
 * `--only` and `--skip` are NOT interchangeable. `--skip` still registers the criterion, as an
 * unmet one, so a run that looked at part of the contract reports incomplete; `--only` does not
 * register the excluded criteria at all, which is what the `docs-links` CI job needs — it has no
 * deployment to hold the other five against. Refused together: the combination has no one meaning.
 */

const CHECK_IDS = ["governance", "publishers", "frontend", "mcp", "skill", "docs"];

const NUMERIC = new Set(["--timeout", "--concurrency"]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;
const MCP_SPEC_HELP =
  'a dist-tag ("next"), an exact version ("0.1.0"), or "local"; a full "@the-rfp-hub/mcp@<x>" is accepted and normalized to "<x>"';

/**
 * Normalize `--mcp-spec` to what follows `npx -y @the-rfp-hub/mcp@`. The full-package form is
 * accepted and stripped because the runbook spells it that way, and concatenating it produced
 * `@the-rfp-hub/mcp@@the-rfp-hub/mcp@next` — an npm ENOENT nobody could read back to the flag. A
 * range is refused: this criterion is about one immutable artifact, and a range does not name one.
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

/** A run narrowed by --only/--skip/--offline is not an M4 sign-off, and must not read as one. */
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
