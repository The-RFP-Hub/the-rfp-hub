/**
 * Argument parsing and refusals for `scripts/accept-writes.mjs`, which WRITES.
 *
 * Every refusal here exists because the tool submits entries, mints a credential and generates
 * traffic against whatever it is pointed at:
 *
 *   1. **The target is allowlisted**, by `target-guard.mjs` — loopback or a named staging origin,
 *      https off loopback, the redirect chain re-checked. There is no flag that unlocks production.
 *   2. **It will not run without a namespace and a publisher credential.** A tool that quietly
 *      performed the two criteria it could and reported them as an acceptance run would be worse
 *      than no tool.
 *   3. **It will not run without a reviewer credential either.** The teardown rejects and unlists
 *      the fixtures with one, so a run that cannot tear down must not start — it would leave rows
 *      in somebody's deployment and be green about it.
 *
 * WHY THE CREDENTIALS ALSO COME FROM THE ENVIRONMENT. Credentials passed as argv are visible to
 * every process on the machine: `ps` prints a full command line, and these are a live session token
 * and a live API key. A harness that boots a stack and then runs this checker against it (see the
 * e2e runner) hands them over in the child's environment instead, which `ps` does not print. The
 * flags still WIN, so an exported variable left over from an earlier session cannot silently
 * redirect a deliberate run.
 */
import { defaultReportPath } from "./options.mjs";
import { targetRefusal } from "./target-guard.mjs";

const NUMERIC = new Set(["--views", "--timeout", "--concurrency"]);

const CREDENTIAL_ENV = {
  sessionToken: "COMPLIANCE_SESSION_TOKEN",
  adminToken: "COMPLIANCE_ADMIN_TOKEN",
  apiKey: "COMPLIANCE_API_KEY",
};

/** A slug is the id prefix of everything this run writes, so it is held to the shape ids are. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseArgs(argv, env = process.env) {
  const opts = {
    milestone: undefined,
    api: undefined,
    namespace: undefined,
    json: undefined,
    views: 5,
    timeoutMs: 20000,
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
      case "--session-token":
        opts.sessionToken = next();
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

  for (const [key, variable] of Object.entries(CREDENTIAL_ENV)) {
    if (opts[key] === undefined && env[variable]) opts[key] = env[variable];
  }
  if (opts.json === undefined) opts.json = defaultReportPath("accept-report");
  return opts;
}

/**
 * Everything that has to be true before a single request is made. Empty means go.
 *
 * The reviewer credential is required rather than preferred: without one the teardown cannot take
 * the fixtures off the public surface, and a run that cannot clean up after itself has no business
 * writing to a deployment in the first place.
 */
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
  if (opts.api) {
    const refusal = targetRefusal(opts.api, env);
    if (refusal) reasons.push(refusal);
  }
  return reasons;
}
