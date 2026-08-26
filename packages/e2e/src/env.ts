import { randomBytes } from "node:crypto";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "./redact.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");
export const apiDir = join(repoRoot, "packages", "api");
export const frontendDir = join(repoRoot, "packages", "frontend");

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

// ── the identity secret ─────────────────────────────────────────────────────────────────────────

/**
 * The signing secret for this run's sessions.
 *
 * Generated per run and thrown away with it. There is no tenant to borrow one from any more, and
 * nothing outside this process needs to verify a token it did not issue — so a fresh random secret
 * is strictly better than a configured one: two concurrent runs cannot accept each other's sessions
 * even by accident.
 *
 * It IS a long-lived secret for the length of the run (it signs every token), so it is registered
 * with the redactor and the end-of-run artifact scan searches for it.
 */
export function newAuthSecret(): string {
  const secret = randomBytes(32).toString("base64url");
  register(secret, { label: "better-auth-secret", longLived: true });
  return secret;
}

// ── the API child ─────────────────────────────────────────────────────────────────────────────

export interface ApiEnvInput {
  /** The RESTRICTED runtime role's URL. Least privilege is the point; see `postgres.ts`. */
  databaseUrl: string;
  port: number;
  /** Signs this run's session tokens. Per run; see `newAuthSecret`. */
  authSecret: string;
  /** Where the API writes sign-in codes, inside the run's own 0700 directory. */
  outboxDir: string;
  /** The frontend's origin, so sign-in and the handoff are permitted to come from it. */
  frontendOrigin: string;
  /**
   * `null` for the one instance `ssrf.spec.ts` boots to prove an unconfigured deployment refuses to
   * sign anybody in. Every other instance uses the file transport.
   */
  emailTransport?: "file" | "null";
  /** Per-run, so analytics hashes cannot be correlated across runs. */
  analyticsHmacKey: string;
  /**
   * False ONLY for the short-lived instance `ssrf.spec.ts` boots to prove the direct-target
   * refusals. Every other instance needs it true, because the fixture web server the verification
   * tests fetch is itself on 127.0.0.1.
   */
  allowPrivateHosts: boolean;
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

  // ── identity ────────────────────────────────────────────────────────────────────────────────
  //
  // ONE SECRET, GENERATED PER RUN, AND NOTHING ELSE. There is no app id, no verification key and no
  // tenant: the API is the identity provider now, and the only thing it needs is something to sign
  // sessions with.
  env.BETTER_AUTH_SECRET = input.authSecret;
  // The callback base — the API's own origin. Deliberately not `PUBLIC_BASE_URL`, which is the
  // OpenAPI `servers[0].url` and may legitimately differ.
  env.BETTER_AUTH_URL = `http://127.0.0.1:${input.port}`;
  // Exact origins, never a wildcard: this list is the CSRF check, the `callbackURL` allowlist, the
  // handoff redirect allowlist and the `/api/auth/*` CORS allowlist all at once.
  env.TRUSTED_ORIGINS = [input.frontendOrigin, `http://127.0.0.1:${input.port}`].join(",");

  // Codes are written to a file inside the run's own directory rather than sent anywhere. This is
  // the whole reason the suite needs no external configuration — and `config.ts` refuses to boot a
  // production process with any transport that reveals the code instead of delivering it.
  env.EMAIL_TRANSPORT = input.emailTransport ?? "file";
  env.EMAIL_FROM = "no-reply@rfphub.invalid";
  if ((input.emailTransport ?? "file") === "file") env.EMAIL_OUTBOX_DIR = input.outboxDir;

  // NO BOOTSTRAP LIST. The API no longer promotes anyone from its environment: administrators are
  // made by an operator ceremony against the database credential (`pnpm --filter @the-rfp-hub/api
  // grant-admin`), which the runner performs during bring-up. A privileged-identity list in a
  // service's environment grants the role on every login, to whoever holds the deployment
  // configuration, and nothing in the product can revoke it — so there is deliberately nothing to
  // set here.

  // The lexical featurizer is in-process and deterministic — same detector as production, no
  // extra run, nothing threaded in.
  env.EMBEDDING_PROVIDER = "lexical";

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

// ── the frontend child ────────────────────────────────────────────────────────────────────────

export interface FrontendEnvInput {
  apiPort: number;
}

/**
 * `next dev` is used rather than `next build && next start`.
 *
 * `NEXT_PUBLIC_*` is inlined at COMPILE time, and in dev that compile happens per route after the
 * process has already started — so a correctly-env'd dev child needs no build step, while a
 * production build would bake the values in and cost minutes on every run. `proxy.ts` reads
 * `process.env.NEXT_PUBLIC_API_URL` per request for the CSP `connect-src`, which works either way.
 */
export function frontendEnv(input: FrontendEnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();
  env.NODE_ENV = "development";
  env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${input.apiPort}`;
  // No identity-provider app id: the frontend talks to our own `/api/auth/*`, whose origin it
  // already knows from `NEXT_PUBLIC_API_URL`.
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
  sessionToken?: string;
  adminToken?: string;
  apiKey?: string;
}

/**
 * Credentials for `scripts/check-m3.mjs` go through the ENVIRONMENT, not argv.
 *
 * argv is world-readable through `ps`, and these are a live session token and a live API key.
 * `scripts/m3-compliance/options.mjs` accepts `M3_SESSION_TOKEN` / `M3_ADMIN_TOKEN` / `M3_API_KEY`
 * for exactly this reason; the flags still win where both are given.
 */
export function checkM3Env(input: CheckM3EnvInput): NodeJS.ProcessEnv {
  const env = baseEnv();
  if (input.sessionToken) env.M3_SESSION_TOKEN = input.sessionToken;
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
