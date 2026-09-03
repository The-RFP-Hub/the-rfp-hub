/**
 * Argument parsing and refusals for `scripts/accept-writes.mjs`, which WRITES.
 *
 * Three refusals, all because the tool submits entries against whatever it is pointed at: the
 * target must be allowlisted (`target-guard.mjs`); a namespace and a publisher credential are
 * required, because a run that quietly performed only the criteria it could would report an
 * acceptance it had not established; and a reviewer credential is required too, because the
 * teardown rejects and unlists with one and a run that cannot tear down must not start.
 *
 * Credentials also come from the environment because argv is world-readable through `ps` and these
 * are live tokens. The flags still WIN, so a variable left over from an earlier session cannot
 * silently redirect a deliberate run.
 */
import { WRITE_CRITERIA, criterionKeys } from "./criteria.mjs";
import { defaultReportPath, normalizeMcpSpec } from "./options.mjs";
import { targetRefusal } from "./target-guard.mjs";

const NUMERIC = new Set(["--views", "--timeout", "--concurrency", "--approve-timeout"]);

/**
 * Env names in the order they are consulted. The `RFPHUB_` pair is what the MCP server's own
 * documentation spells for the same two credentials, so both are accepted rather than making an
 * operator hold two names for one token.
 */
const CREDENTIAL_ENV = {
  sessionToken: ["COMPLIANCE_SESSION_TOKEN"],
  adminToken: ["COMPLIANCE_ADMIN_TOKEN"],
  apiKey: ["COMPLIANCE_API_KEY"],
  reviewerToken: ["COMPLIANCE_REVIEWER_TOKEN", "RFPHUB_REVIEWER_TOKEN"],
  writeKey: ["COMPLIANCE_WRITE_KEY", "RFPHUB_WRITE_KEY"],
};

const SUBMISSION_CREDENTIALS = new Set(["reviewerToken", "writeKey"]);

/** A slug is the id prefix of everything this run writes, so it is held to the shape ids are. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseArgs(argv, env = process.env) {
  const opts = {
    milestone: undefined,
    api: undefined,
    namespace: undefined,
    repoRoot: process.cwd(),
    mcpSpec: undefined,
    interactiveApproval: false,
    only: new Set(),
    skip: new Set(),
    json: undefined,
    views: 5,
    timeoutMs: 20000,
    approveTimeoutMs: 15000,
    concurrency: 4,
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
    const criterion = (flag) => {
      const value = next();
      const known = criterionKeys(WRITE_CRITERIA);
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
      case "--milestone":
        opts.milestone = next().toLowerCase();
        break;
      case "--base-url":
      case "--api":
        opts.api = next();
        break;
      case "--namespace":
        opts.namespace = next();
        break;
      case "--only":
        opts.only.add(criterion("--only"));
        break;
      case "--skip":
        opts.skip.add(criterion("--skip"));
        break;
      case "--session-token":
        opts.sessionToken = next();
        break;
      case "--api-key":
        opts.apiKey = next();
        break;
      case "--admin-token":
        opts.adminToken = next();
        break;
      case "--reviewer-token":
        opts.reviewerToken = next();
        break;
      case "--write-key":
        opts.writeKey = next();
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
      case "--approve-timeout":
        opts.approveTimeoutMs = number(next());
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

  if (opts.only.size > 0 && opts.skip.size > 0) {
    throw new Error("--only and --skip cannot be combined: --only already says what runs");
  }
  // The m4 names are read only under the m4 profile: a token left in the environment from an
  // earlier submission run must not quietly outrank an --admin-token passed to an m3 run.
  const submission = opts.milestone === "m4";
  for (const [key, variables] of Object.entries(CREDENTIAL_ENV)) {
    if (!submission && SUBMISSION_CREDENTIALS.has(key)) continue;
    for (const variable of variables) {
      if (opts[key] === undefined && env[variable]) opts[key] = env[variable];
    }
  }
  // Waiting on a person is not waiting on a process: 15s is right for a driven CLI, absurd here.
  if (opts.interactiveApproval && !argv.includes("--approve-timeout")) {
    opts.approveTimeoutMs = 300000;
  }
  if (opts.json === undefined) opts.json = defaultReportPath("accept-report");
  return opts;
}

/** Everything that has to be true before a single request is made. Empty means go. */
export function refusals(opts, milestones, env = process.env) {
  const reasons = [];
  const known = Object.keys(milestones);
  if (!opts.milestone) {
    reasons.push(`--milestone is required — one of ${known.join(", ")}`);
  } else if (!milestones[opts.milestone]) {
    reasons.push(
      opts.milestone === "m2"
        ? "the M2 criteria only read — run them with `pnpm check:deployment --milestone m2`"
        : `unknown milestone "${opts.milestone}" — this tool knows ${known.join(", ")}`,
    );
  }
  if (!opts.api) reasons.push("--api is required");
  reasons.push(...crossProfileRefusals(opts, milestones));
  if (opts.milestone === "m4") {
    reasons.push(...submissionRefusals(opts));
  } else {
    reasons.push(...publisherRefusals(opts));
  }
  if (opts.api) {
    const refusal = targetRefusal(opts.api, env);
    if (refusal) reasons.push(refusal);
  }
  return reasons;
}

/**
 * The registry validates `--only` against every write criterion, but the state, the fixture ids and
 * the teardown follow `--milestone`: `--milestone m4 --only lifecycle` wrote an M3 fixture the M4
 * teardown does not know to remove, and left it on the deployment.
 */
function crossProfileRefusals(opts, milestones) {
  const profile = milestones[opts.milestone];
  if (!profile) return [];
  const reasons = [];
  const owner = (key) =>
    Object.entries(milestones).find(([, keys]) => keys.includes(key))?.[0] ?? "no profile";
  for (const flag of ["only", "skip"]) {
    for (const key of opts[flag] ?? []) {
      if (profile.includes(key)) continue;
      reasons.push(
        `--${flag} ${key} is not part of the ${opts.milestone.toUpperCase()} profile (${profile.join(", ")}) — ${key} belongs to ${owner(key)}, and the fixtures it writes are torn down by that profile's teardown, not this one`,
      );
    }
  }
  return reasons;
}

/** The m4 profile submits through the MCP server, so it needs that server's two credentials. */
function submissionRefusals(opts) {
  const reasons = [];
  if (!opts.reviewerToken) {
    reasons.push(
      "a reviewer credential is required (--reviewer-token, COMPLIANCE_REVIEWER_TOKEN or RFPHUB_REVIEWER_TOKEN) — the teardown rejects and unlists the entry this run submits, and a run that cannot tear down must not start",
    );
  }
  if (!opts.writeKey) {
    reasons.push(
      "a write credential is required (--write-key, COMPLIANCE_WRITE_KEY or RFPHUB_WRITE_KEY) — a write-scoped rfph_ key, never a publish-scoped one, so the fixture lands pending by construction, which is the property this profile proves",
    );
  }
  return reasons;
}

function publisherRefusals(opts) {
  const reasons = [];
  if (!opts.namespace) {
    reasons.push(
      "--namespace is required — this run WRITES, and that is the namespace it writes in",
    );
  } else if (!SLUG.test(opts.namespace)) {
    reasons.push(`--namespace must be a lowercase hyphenated slug, got "${opts.namespace}"`);
  }
  if (!opts.sessionToken && !opts.apiKey) {
    reasons.push(
      "one of --session-token or --api-key is required (or COMPLIANCE_SESSION_TOKEN / COMPLIANCE_API_KEY) — most of the criteria are about the write surface, and a run that silently checked only the others would report an acceptance it had not established",
    );
  }
  if (!opts.adminToken && !opts.sessionToken) {
    reasons.push(
      "a reviewer credential is required (--admin-token, or COMPLIANCE_ADMIN_TOKEN, or a --session-token whose account may review) — the teardown rejects and unlists everything this run creates, and a run that cannot tear down must not start",
    );
  }
  return reasons;
}
