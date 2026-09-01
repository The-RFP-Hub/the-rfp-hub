/**
 * Argument parsing and refusals for `scripts/accept-m4.mjs`.
 *
 * This tool WRITES: it drives a real 3-phase MCP submission against `--api` with a write-scoped
 * key and tears the fixture down with a reviewer session. So the target guard is DEFAULT-DENY
 * against an explicit allowlist of this project's own staging origins plus loopback, and THERE IS
 * NO FLAG TO FORCE PRODUCTION.
 *
 * WHY NOT THE M3 CHECKER'S HOSTNAME HEURISTIC. `m3-compliance/options.mjs` asks whether any
 * dot/dash/underscore segment of the hostname reads like a non-production environment. That admits
 * `not-staging-anymore.example.org`, `production-staging.example.org` and an attacker-controlled
 * `staging.` CNAME — hostname text cannot prove which deployment answers, and the cost of being
 * wrong here is a real write to production plus a reviewer credential on the wire.
 */
import { isLoopbackHost, request } from "../../m2-compliance/http.mjs";
import { normalizeMcpSpec } from "../options.mjs";

export { isLoopbackHost };

/** The project's real staging origins, from `.github/workflows/*staging*.yml` and `adr/0007`. */
export const STAGING_ORIGINS = ["https://staging.ethrfps.app", "https://api-staging.ethrfps.app"];

/** Named so a refusal can say "that is production", not just "that is not on the list". */
const PRODUCTION_HOSTS = ["ethrfps.app", "api.ethrfps.app", "www.ethrfps.app"];

export const EXTRA_ORIGIN_ENV = "RFPHUB_ACCEPT_EXTRA_STAGING_ORIGIN";

const CREDENTIAL_ENV = {
  reviewerToken: "RFPHUB_REVIEWER_TOKEN",
  writeKey: "RFPHUB_WRITE_KEY",
};

/**
 * Scheme + host + non-default port, lowercased, trailing root dot stripped, userinfo refused.
 * Returns `null` for anything that cannot be classified, which the caller treats as a refusal —
 * an unparseable target is certainly not a safe one.
 */
export function normalizeOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return { origin: `${url.protocol}//${host}${port}`, protocol: url.protocol, host };
}

/**
 * Whether an operator-supplied extra origin is allowed to join the allowlist: https, and a full
 * dot-delimited label that names staging. `production-staging.example.org` is refused even here —
 * a label carrying `prod` is not made safe by also carrying `staging`.
 */
function namesStaging(host) {
  const labels = host.split(".");
  if (labels.some((label) => label.includes("prod"))) return false;
  return labels.some(
    (label) => label === "staging" || label.startsWith("staging-") || label.endsWith("-staging"),
  );
}

/** The allowlist for this run: the project's staging origins, plus one opt-in from the env. */
export function allowedOrigins(env = process.env) {
  const allowed = [...STAGING_ORIGINS];
  const extra = normalizeOrigin(env[EXTRA_ORIGIN_ENV]);
  if (extra && extra.protocol === "https:" && namesStaging(extra.host)) allowed.push(extra.origin);
  return allowed;
}

/** Why this target must not be written to, or `null` when it may be. */
export function targetRefusal(api, env = process.env) {
  const parsed = normalizeOrigin(api);
  if (!parsed) {
    return `--api must be an absolute http(s) URL with no userinfo, got "${api}"`;
  }
  if (isLoopbackHost(parsed.host)) return null;
  if (parsed.protocol !== "https:") {
    return `${parsed.origin} is not https, and this tool sends a reviewer session and a write-scoped key — only loopback may be plaintext`;
  }
  const allowed = allowedOrigins(env);
  if (allowed.includes(parsed.origin)) return null;
  const production = PRODUCTION_HOSTS.includes(parsed.host)
    ? `${parsed.origin} is PRODUCTION. `
    : "";
  return `${production}${parsed.origin} is not an allowed write target. This tool writes a real entry through the MCP interlock, so it accepts only loopback or ${allowed.join(", ")}. There is no flag to force production; add another staging origin with ${EXTRA_ORIGIN_ENV}=<https origin whose hostname carries a "staging" label>`;
}

/**
 * Follow the redirect chain `--api` actually answers with and refuse when it leaves the
 * allowlist. A staging-looking CNAME pointed at production passes every hostname rule there is;
 * only the origin that finally answers settles it, so this runs before the first write.
 */
export async function redirectRefusal(api, { timeoutMs = 10000, env = process.env } = {}) {
  let target = `${api}/v1/health`;
  for (let hop = 0; hop < 5; hop++) {
    const res = await request(target, { timeoutMs });
    if (!res.ok) return null; // a transport failure is the flow's problem to report, not a refusal
    if (res.status < 300 || res.status >= 400 || !res.location) return null;
    let next;
    try {
      next = new URL(res.location, target).href;
    } catch {
      return `${target} redirects to an unparseable Location "${res.location}"`;
    }
    const refusal = targetRefusal(next, env);
    if (refusal) return `${api} redirects to ${next}, and ${refusal}`;
    target = next;
  }
  return `${api} redirects more than 5 times — the origin that finally answers cannot be established`;
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    api: undefined,
    repoRoot: process.cwd(),
    mcpSpec: undefined,
    interactiveApproval: false,
    keepFixture: false,
    json: undefined,
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
        opts.mcpSpec = normalizeMcpSpec(next());
        break;
      case "--interactive-approval":
        opts.interactiveApproval = true;
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
      case "--approve-timeout":
        opts.approveTimeoutMs = number(next());
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
  // Waiting on a person is not waiting on a process: 15s is right for a driven CLI and absurd for
  // an operator who has to open another terminal.
  if (opts.interactiveApproval && !argv.includes("--approve-timeout")) {
    opts.approveTimeoutMs = 300000;
  }

  return opts;
}

/** Everything that must be true before this tool touches the network. Empty means go. */
export function refusals(opts, env = process.env) {
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
  if (opts.api) {
    const refusal = targetRefusal(opts.api, env);
    if (refusal) reasons.push(refusal);
  }
  return reasons;
}
