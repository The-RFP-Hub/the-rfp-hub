/**
 * Argument parsing and the two refusals for the M3 compliance checker.
 *
 * Separated from `check-m3.mjs` because both refusals are rules with edge cases, and a rule with
 * edge cases should be testable without starting a run (`options.test.mjs`).
 *
 * WHY THIS TOOL REFUSES THINGS THE M2 CHECKER DOES NOT.
 *
 * check-m2 is a read-only probe: it fetches public documents and compares them to a published
 * contract. Running it against anything, twice, from anywhere, costs nothing. This one is
 * different in kind — it SUBMITS entries, mints a key, generates analytics traffic and asks a
 * reviewer to close things. It writes. So:
 *
 *   1. **It will not run without credentials and a namespace.** A tool that quietly performed the
 *      three read-only criteria and reported them as a passing M3 sign-off would be worse than no
 *      tool: five of the seven criteria are about the write surface.
 *   2. **It will not touch production unless told to, in those words.** The guard is DEFAULT-DENY
 *      on anything that does not obviously look like a staging or local target, rather than a
 *      blocklist of production hostnames — a blocklist has to be right about a name nobody
 *      remembered to add, and the failure mode is fixture rows in the live dataset.
 */

/** Hosts whose traffic never leaves the machine. Same rule as the M2 checker's. */
export function isLoopbackHost(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether a target must be explicitly unlocked with `--allow-production`.
 *
 * True unless the host is loopback or carries a segment that names a non-production environment.
 * A segment, not a substring: `staging.example.org` and `api-staging.example.org` are unlocked,
 * `not-staging-anymore.example.org` is not, and neither is a production host that happens to
 * contain the letters.
 */
export function requiresProductionOptIn(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // An unparseable URL is somebody else's error to report; it is certainly not a safe target.
    return true;
  }
  if (isLoopbackHost(host)) return false;
  const segments = host.split(/[.\-_]/);
  return !segments.some((segment) =>
    ["staging", "stage", "stg", "test", "testing", "dev", "development", "sandbox"].includes(
      segment,
    ),
  );
}

const NUMERIC = new Set(["--views", "--timeout", "--concurrency"]);

export function parseArgs(argv) {
  const opts = {
    json: "m3-compliance-report.json",
    views: 5,
    timeoutMs: 20000,
    concurrency: 4,
    allowProduction: false,
    keepFixtures: false,
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
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--namespace":
        opts.namespace = next();
        break;
      case "--privy-token":
        opts.privyToken = next();
        break;
      case "--api-key":
        opts.apiKey = next();
        break;
      case "--admin-token":
        opts.adminToken = next();
        break;
      case "--application-url":
        opts.applicationUrl = next();
        break;
      case "--json":
        opts.json = next();
        break;
      case "--views":
        opts.views = number(next());
        break;
      case "--timeout":
        opts.timeoutMs = number(next());
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, number(next()));
        break;
      case "--allow-production":
        opts.allowProduction = true;
        break;
      case "--keep-fixtures":
        opts.keepFixtures = true;
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

/** A slug is the id prefix of everything this run writes, so it is held to the same shape ids are. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Everything that has to be true before a single request is made. Returns the list of reasons the
 * run must not start; empty means go.
 */
export function refusals(opts) {
  const reasons = [];
  if (!opts.baseUrl) reasons.push("--base-url is required");
  if (!opts.namespace) {
    reasons.push(
      "--namespace is required — this run WRITES, and that is the namespace it writes in",
    );
  } else if (!SLUG.test(opts.namespace)) {
    reasons.push(`--namespace must be a lowercase hyphenated slug, got "${opts.namespace}"`);
  }
  if (!opts.privyToken && !opts.apiKey) {
    reasons.push(
      "one of --privy-token or --api-key is required — five of the seven criteria are about the write surface, and a run that silently checked only the other two would report a passing M3 sign-off it had not established",
    );
  }
  if (opts.baseUrl && !opts.allowProduction && requiresProductionOptIn(opts.baseUrl)) {
    reasons.push(
      `${opts.baseUrl} does not look like a staging or local target, and this checker WRITES: it submits entries, mints a key and generates traffic. Pass --allow-production if you really mean it`,
    );
  }
  return reasons;
}
