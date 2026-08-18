/**
 * The environment every child process gets — built from `{}`, never inherited.
 *
 * WHY NOT `{...process.env, …}`. The API's configuration is entirely environmental, and several of
 * its variables change what the suite is actually testing:
 *
 *   VERIFY_ALLOW_PRIVATE_HOSTS  turns the SSRF address checks off — the assertion in `ssrf.spec.ts`
 *                               is that a refusal HAPPENS, so an inherited `true` would make the
 *                               spec fail loudly, but an inherited value on the OTHER instance
 *                               would make a passing verification test prove nothing
 *   VERIFIER_EGRESS_PROXY       replaces per-hop address pinning with trust in a proxy
 *   TRUST_PROXY                 changes which address analytics attributes a request to
 *   DATABASE_URL                would point the API at the developer's own database — the single
 *                               most damaging thing this suite could do
 *   OPENAI_API_KEY              flips embeddings from deterministic to a paid, non-deterministic
 *                               provider, and sends fixture text to a third party
 *   PORT / NODE_ENV             collide with the run-scoped values below
 *
 * None of those can be "remembered to unset". Building from `{}` means the only way a variable
 * reaches a child is by being written here, on purpose, and an inherited shell export or a stray
 * `.env` cannot change what the run proves. The cost is that every genuinely required variable has
 * to be listed — which is the readable half of the trade.
 *
 * `packages/api/src/config.ts` runs `dotenv.config()` from its own working directory and dotenv
 * never overwrites a variable that already reached the process, so everything set here WINS over
 * `packages/api/.env`. That file is read once, read-only, for the Privy credentials, and never
 * written.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { presence, register } from "./redact.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");
export const apiDir = join(repoRoot, "packages", "api");
export const dashboardDir = join(repoRoot, "packages", "dashboard");

/**
 * The only variables inherited from the ambient environment, and why each one has to be.
 *
 * PATH — nothing spawns without it. HOME — pnpm, Next and Playwright all resolve caches under it,
 * and a child without one re-downloads or fails. SHELL/LANG — cosmetic, but their absence changes
 * error formatting in ways that make failures harder to read. TMPDIR — the OS temp location, which
 * a sandboxed environment may have moved.
 */
const INHERITED = ["PATH", "HOME", "SHELL", "LANG", "TMPDIR"] as const;

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ── tenant credentials ────────────────────────────────────────────────────────────────────────

export interface TenantCredentials {
  appId: string | undefined;
  /** Stays in the runner. Never reaches an API process — see `apiEnv`. */
  appSecret: string | undefined;
  verificationKey: string | undefined;
  /** Where each value came from, for the preflight report. Presence only, never a value. */
  report: Record<
    string,
    { source: "environment" | "packages/api/.env" | "none"; presence: string }
  >;
}

/**
 * Reads the Privy app credentials, preferring real environment variables and falling back to
 * `packages/api/.env`.
 *
 * The file is parsed with `dotenv.parse` on a string this function read itself — NOT
 * `dotenv.config()`, which would mutate `process.env` of the runner and, through it, of anything
 * that later built an environment less carefully than this module does. Reading is the whole
 * contract: nothing here writes to that file, and `scripts/check-deploy.mjs` independently
 * guarantees it never enters a build context.
 */
export function readTenantCredentials(): TenantCredentials {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotenv(readFileSync(join(apiDir, ".env"), "utf8"));
  } catch {
    // Absent or unreadable is a normal state — the preflight reports it and the ladder degrades.
  }

  const report: TenantCredentials["report"] = {};
  const pick = (key: string): string | undefined => {
    const fromEnv = process.env[key];
    const value = fromEnv ?? fromFile[key];
    report[key] = {
      source: fromEnv ? "environment" : fromFile[key] ? "packages/api/.env" : "none",
      presence: presence(value),
    };
    return value || undefined;
  };

  const appId = pick("PRIVY_APP_ID");
  const appSecret = pick("PRIVY_APP_SECRET");
  const verificationKey = pick("PRIVY_VERIFICATION_KEY");

  // The app secret is the run's most consequential long-lived secret: it is a standing credential
  // for a real tenant. Registering it here means the end-of-run artifact scan is looking for it
  // whether or not any code path ever printed it.
  register(appSecret, { label: "privy-app-secret", longLived: true });

  return { appId, appSecret, verificationKey, report };
}

// ── the API child ─────────────────────────────────────────────────────────────────────────────

export interface ApiEnvInput {
  /** The RESTRICTED runtime role's URL. Least privilege is the point; see `postgres.ts`. */
  databaseUrl: string;
  port: number;
  appId: string | undefined;
  verificationKey: string | undefined;
  /** Per-run, so analytics hashes cannot be correlated across runs. */
  analyticsHmacKey: string;
  /**
   * False ONLY for the short-lived instance `ssrf.spec.ts` boots to prove the direct-target
   * refusals. Every other instance needs it true, because the fixture web server the verification
   * tests fetch is itself on 127.0.0.1.
   */
  allowPrivateHosts: boolean;
  /** `openai` only in the optional extra run; the key is threaded in only then. */
  embeddingProvider?: "deterministic" | "openai";
  openaiApiKey?: string;
  verifyMaxBytes?: number;
}

export function apiEnv(input: ApiEnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();

  env.NODE_ENV = "test";
  env.DATABASE_URL = input.databaseUrl;
  env.PORT = String(input.port);
  // config.ts:406 defaults HOST to 0.0.0.0. A test stack that binds every interface is a test
  // stack reachable from the network, so it is set explicitly rather than left to the default.
  env.HOST = "127.0.0.1";

  if (input.appId) env.PRIVY_APP_ID = input.appId;
  if (input.verificationKey) env.PRIVY_VERIFICATION_KEY = input.verificationKey;
  // PRIVY_APP_SECRET is deliberately NOT set. `config.ts` reads it optionally and no path this suite
  // exercises needs it.
  // Withholding it means an API process cannot leak a credential it never had.

  // NO BOOTSTRAP LIST. The API no longer promotes anyone from its environment: administrators are
  // made by an operator ceremony against the database credential (`pnpm --filter @the-rfp-hub/api
  // grant-admin`), which the runner performs during bring-up. A privileged-identity list in a
  // service's environment grants the role on every login, to whoever holds the deployment
  // configuration, and nothing in the product can revoke it — so there is deliberately nothing to
  // set here.

  env.EMBEDDING_PROVIDER = input.embeddingProvider ?? "deterministic";
  if (input.embeddingProvider === "openai") {
    if (!input.openaiApiKey) {
      throw new Error("env: EMBEDDING_PROVIDER=openai was requested without an OPENAI_API_KEY");
    }
    env.OPENAI_API_KEY = input.openaiApiKey;
  }

  env.ANALYTICS_ENABLED = "true";
  env.ANALYTICS_HMAC_KEY = input.analyticsHmacKey;

  env.VERIFICATION_ENABLED = "true";
  // Verification is triggered explicitly by the specs, so they can assert on the run they caused
  // rather than racing a submit-time one.
  env.VERIFY_ON_SUBMIT = "false";
  env.VERIFY_MAX_BYTES = String(input.verifyMaxBytes ?? 2 * 1024 * 1024);
  if (input.allowPrivateHosts) env.VERIFY_ALLOW_PRIVATE_HOSTS = "true";

  env.STALENESS_INACTIVE_DAYS = "90";
  env.DB_POOL_MAX = "10";

  // PUBLIC_BASE_URL and TRUST_PROXY are deliberately absent: config.ts throws on a bad value for
  // either, and neither has a value this suite needs. TRUST_PROXY unset also means every request's
  // `ip` is 127.0.0.1, which collapses visitor-uniqueness across identities — the analytics
  // criteria therefore assert view and click COUNTS, and the report says so.

  return env;
}

// ── the dashboard child ───────────────────────────────────────────────────────────────────────

export interface DashboardEnvInput {
  apiPort: number;
  appId: string | undefined;
}

/**
 * `next dev` is used rather than `next build && next start`.
 *
 * `NEXT_PUBLIC_*` is inlined at COMPILE time, and in dev that compile happens per route after the
 * process has already started — so a correctly-env'd dev child needs no build step, while a
 * production build would bake the values in and cost minutes on every run. `proxy.ts` reads
 * `process.env.NEXT_PUBLIC_API_URL` per request for the CSP `connect-src`, which works either way.
 */
export function dashboardEnv(input: DashboardEnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();
  env.NODE_ENV = "development";
  env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${input.apiPort}`;
  if (input.appId) env.NEXT_PUBLIC_PRIVY_APP_ID = input.appId;
  // Next's telemetry pings a remote endpoint on first run; a test harness should not.
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

// ── the migration child ───────────────────────────────────────────────────────────────────────

/** `pnpm --filter @the-rfp-hub/api migrate` against the ADMIN url — the owner role, never runtime. */
export function migrateEnv(adminDatabaseUrl: string): NodeJS.ProcessEnv {
  const env = baseEnv();
  env.NODE_ENV = "test";
  env.DATABASE_URL = adminDatabaseUrl;
  return env;
}

// ── the check-m3 child ────────────────────────────────────────────────────────────────────────

export interface CheckM3EnvInput {
  privyToken?: string;
  adminToken?: string;
  apiKey?: string;
}

/**
 * Credentials for `scripts/check-m3.mjs` go through the ENVIRONMENT, not argv.
 *
 * argv is world-readable through `ps`, and these are a live session token and a live API key.
 * `scripts/m3-compliance/options.mjs` accepts `M3_PRIVY_TOKEN` / `M3_ADMIN_TOKEN` / `M3_API_KEY`
 * for exactly this reason; the flags still win where both are given.
 */
export function checkM3Env(input: CheckM3EnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();
  if (input.privyToken) env.M3_PRIVY_TOKEN = input.privyToken;
  if (input.adminToken) env.M3_ADMIN_TOKEN = input.adminToken;
  if (input.apiKey) env.M3_API_KEY = input.apiKey;
  env.NO_COLOR = "1";
  return env;
}

// ── the Playwright child ──────────────────────────────────────────────────────────────────────

export interface PlaywrightEnvInput {
  stateFile: string;
  secretsFile: string;
  tmpDir: string;
}

/**
 * Playwright is the one child that is allowed a wider environment: it has to find its own browser
 * download cache, and it is OUR code end to end (no third-party service reads it). It still gets
 * an explicit allowlist plus the three pointers a worker needs to find the run's state.
 */
export function playwrightEnv(input: PlaywrightEnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();
  for (const key of ["PLAYWRIGHT_BROWSERS_PATH", "DISPLAY", "CI", "FORCE_COLOR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.E2E_STATE_FILE = input.stateFile;
  env.E2E_SECRETS_FILE = input.secretsFile;
  env.E2E_TMP_DIR = input.tmpDir;
  return env;
}
