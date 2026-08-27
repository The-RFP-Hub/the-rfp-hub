/**
 * Argument parsing and refusals for `scripts/accept-m4.mjs`.
 *
 * Same reasoning as `m3-compliance/options.mjs`, reused rather than re-derived: this tool WRITES
 * (it drives a real 3-phase MCP submission against `--api`), so it refuses to run against anything
 * that doesn't look like staging or local, and it refuses to run without the two credentials the
 * flow needs. `requiresProductionOptIn` / `isLoopbackHost` are imported from the M3 checker's
 * options module rather than copied — the rule ("does this host look like production") has exactly
 * one implementation, and a second hand-copied one is a second place for it to quietly drift.
 */
import { isLoopbackHost, requiresProductionOptIn } from "../../m3-compliance/options.mjs";

export { isLoopbackHost, requiresProductionOptIn };

const CREDENTIAL_ENV = {
  reviewerToken: "RFPHUB_REVIEWER_TOKEN",
  writeKey: "RFPHUB_WRITE_KEY",
};

export function parseArgs(argv, env = process.env) {
  const opts = {
    api: undefined,
    repoRoot: process.cwd(),
    mcpSpec: undefined,
    allowProduction: false,
    keepFixture: false,
    json: "m4-accept-report.json",
    timeoutMs: 20000,
    approveTimeoutMs: 15000,
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
      case "--api":
        opts.api = next();
        break;
      case "--repo-root":
        opts.repoRoot = next();
        break;
      case "--mcp-spec":
        opts.mcpSpec = next();
        break;
      case "--allow-production":
        opts.allowProduction = true;
        break;
      case "--keep-fixture":
        opts.keepFixture = true;
        break;
      case "--json":
        opts.json = next();
        break;
      case "--timeout":
        opts.timeoutMs = number(next());
        break;
      case "--no-color":
        opts.color = false;
        break;
      default:
        throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }

  for (const [key, variable] of Object.entries(CREDENTIAL_ENV)) {
    if (opts[key] === undefined && env[variable]) opts[key] = env[variable];
  }

  return opts;
}

const RED = "[31m";
const BOLD = "[1m";
const RESET = "[0m";

/**
 * Everything that has to be true before this tool touches the network. Returns the list of
 * reasons the run must not start; empty means go. The red warning for `--allow-production` is
 * printed separately (see `productionWarning`) so a caller can show it even on a run that
 * otherwise proceeds.
 */
export function refusals(opts) {
  const reasons = [];
  if (!opts.api) reasons.push("--api is required");
  if (!opts.reviewerToken) {
    reasons.push(
      "RFPHUB_REVIEWER_TOKEN is required — the teardown rejects and unlists the fixture with a reviewer session, the same as scripts/m3-compliance/cleanup.mjs",
    );
  }
  if (!opts.writeKey) {
    reasons.push(
      "RFPHUB_WRITE_KEY is required — the 3-phase submission needs a write-scoped rfph_ key (write only, never publish, so the fixture lands pending by construction)",
    );
  }
  if (opts.api && !opts.allowProduction && requiresProductionOptIn(opts.api)) {
    reasons.push(
      `${opts.api} does not look like a staging or local target, and this tool WRITES a real (if prefixed) entry through the MCP interlock. Pass --allow-production if you really mean it`,
    );
  }
  return reasons;
}

/** Printed, in red, whenever `--allow-production` is what let the run start. */
export function productionWarning(apiUrl) {
  return `${BOLD}${RED}⚠ --allow-production: writing to ${apiUrl}, which does not look like staging. There is no further flag to force this — you already passed it.${RESET}`;
}
