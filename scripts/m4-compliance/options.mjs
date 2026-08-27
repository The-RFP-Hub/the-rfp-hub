/**
 * Argument parsing for the M4 compliance checker.
 *
 * Unlike `m3-compliance/options.mjs`, THIS TOOL IS READ-ONLY: it never mints a key, never submits
 * an entry, never asks a reviewer to do anything. So there is no `--allow-production` and no
 * credential handling here — every default points at the live production deployment on purpose,
 * because reading it costs the deployment nothing and that is the whole value of a read-only
 * checker (same reasoning as `check-m2.mjs`).
 */

const CHECK_IDS = ["governance", "publishers", "frontend", "mcp", "skill", "docs"];

const NUMERIC = new Set(["--timeout", "--concurrency"]);

export function parseArgs(argv) {
  const opts = {
    site: "https://ethrfps.app",
    api: "https://api.ethrfps.app",
    repoRoot: process.cwd(),
    json: undefined,
    skip: new Set(),
    browser: false,
    offline: false,
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
      case "--browser":
        opts.browser = true;
        break;
      case "--offline":
        opts.offline = true;
        break;
      case "--mcp-spec":
        opts.mcpSpec = next();
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

  return opts;
}

export { CHECK_IDS };
