/**
 * Runtime configuration of the SERVER, read from the environment with local-friendly defaults.
 *
 * Only what the running service actually needs is here. Ingest-side settings are deliberately
 * absent: the seed loader takes a corpus file as its argument and reads no environment pointer at
 * all, and the one variable that names an upstream (SOURCE_API_URL) is read directly by
 * `tools/converter/fetch-corpus.ts`, an offline tool nothing on a request or seed path invokes. A
 * variable declared here is a variable every deployment has to reason about — so a variable no
 * request path reads does not belong here.
 */
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { isLoopbackHost } from "./shared/loopback.js";

// Load .env (from the working directory — packages/api for every pnpm script here) before any
// process.env read below. dotenv never overwrites variables that already reached the process, so
// exported shell vars and a deployment's injected environment always win over the file.
loadDotenv({ quiet: true });

/** The session authority: what signs session tokens, where it lives, and who may talk to it. */
export interface BetterAuthConfig {
  /**
   * Signs and verifies session tokens (HMAC-SHA256, checked before any database access).
   *
   * ROTATING IT LOGS EVERYONE OUT. There is no dual-secret verification on the bearer path — the
   * library HMACs against exactly one value — so this is a deliberate global sign-out, not a
   * seamless roll. Said here because a reader will otherwise assume the opposite.
   */
  secret: string;
  /** True when the secret came from the environment rather than from a per-boot fallback. */
  secretConfigured: boolean;
  /**
   * The API's OWN origin — the base every auth route and OAuth callback is built from.
   *
   * Deliberately not `publicBaseUrl`, which is the OpenAPI document's `servers[0].url` and may
   * legitimately differ (a docs host, a path prefix behind a gateway).
   */
  url: string;
  /** Exact origins allowed to drive sign-in: CSRF, `callbackURL`, the handoff, and CORS. */
  trustedOrigins: string[];
  /** Staging only: an anchored preview-origin predicate. Never a bare `*.vercel.app`. */
  previewOriginPattern: RegExp | undefined;
}

/** Optional social sign-in. Absent client id → the provider is not registered at all. */
export interface GoogleConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/** How a one-time code reaches a person. */
export type EmailTransportKind = "ses" | "resend" | "file" | "stdout" | "memory" | "null";

export interface EmailConfig {
  transport: EmailTransportKind;
  /** The envelope sender. Required for any transport that actually sends. */
  from: string;
  /** `file` transport only: where the outbox lives. */
  outboxDir: string | undefined;
  /** `ses` transport only. No credential — the task role carries it. */
  sesRegion: string | undefined;
  /** `resend` only. Kept as an interface-level alternative; unused by any deployment today. */
  resendApiKey: string | undefined;
}

export type EmbeddingProvider = "openai" | "deterministic" | "disabled";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
}

export interface DedupeConfig {
  /** Cosine similarity at or above which a pair is recorded as suspected. Per-provider. */
  similarityThreshold: number;
  maxMatches: number;
}

export interface VerificationConfig {
  enabled: boolean;
  onSubmit: boolean;
  timeoutMs: number;
  maxBytes: number;
  queueMax: number;
  /** SSRF escape hatch for one loopback test. Refused outright under NODE_ENV=production. */
  allowPrivateHosts: boolean;
  egressProxy: string | undefined;
}

export interface AnalyticsConfig {
  enabled: boolean;
  /** HMAC key for the session/IP hashes. */
  hmacKey: string;
  /** True when no key was supplied and a per-boot random one is in use. */
  hmacKeyGenerated: boolean;
  retentionDays: number;
}

export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /**
   * Base URL the OpenAPI document advertises as its `servers[0].url` (see plugins/swagger.ts).
   * Defaults to `/` — relative, and therefore correct wherever the server happens to be reachable,
   * which is what local development runs with.
   *
   * In a deployed environment this is the API's OWN origin, never the apex: the apex is the
   * specification's origin, and the Standard's canonical documents and their identifiers are owned
   * by `packages/standard` — no route in this package answers those paths. Pointing
   * `servers[0].url` at the apex would advertise the wrong host for every API operation.
   *
   * The apex reservation (`plugins/apex-host.ts`) reads the same value for the same reason: when it
   * refuses a request on the apex it has to say where the API actually is, and the one URL it must
   * never name is the Standard's `baseUrl`, which IS the host that just refused. At the `/` default
   * the deployment has told us nothing, so the denial says "a different host" rather than guessing.
   */
  publicBaseUrl: string;
  /**
   * Max size of the pg pool. Bound this for shared database instances where connection budget is
   * split across multiple services. Defaults to 10 — pg's own default — so a fresh deployment
   * with no shared-instance constraints needs no configuration.
   */
  dbPoolMax: number;
  /**
   * What Fastify is told to trust for `request.ip` and `request.protocol`.
   *
   * DELIBERATELY NEVER `true`. `X-Forwarded-For` is a client-supplied header, and trusting it
   * unconditionally lets any caller choose the address that ends up in the analytics hash and in
   * any rate-limit key. A hop count or a CIDR list names the proxy that is actually in front of
   * this process. `undefined` (the default) trusts nothing.
   */
  trustProxy: number | string[] | undefined;
  betterAuth: BetterAuthConfig;
  google: GoogleConfig;
  email: EmailConfig;
  embedding: EmbeddingConfig;
  dedupe: DedupeConfig;
  verification: VerificationConfig;
  analytics: AnalyticsConfig;
  /** Days of no publisher touch after which a deadline-less open entry is closed as inactive. */
  stalenessInactiveDays: number;
}

const isProduction = process.env.NODE_ENV === "production";

// Fail fast in production: a missing DATABASE_URL must never silently fall back to a localhost
// database that doesn't exist there. Dev/test keep the docker-compose default so `pnpm dev` works
// with zero setup.
if (isProduction && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required when NODE_ENV=production (no localhost fallback).");
  process.exit(1);
}

const LOCAL_DATABASE_URL = "postgres://rfphub:rfphub@localhost:5432/rfphub";

/**
 * Off the production path the fallback stands — but it announces itself: with the dotenv load
 * above, a DATABASE_URL that is still unset here means no exported variable AND no .env next to
 * this package's package.json, which is otherwise indistinguishable from one nobody meant to set.
 * Admin commands run from a laptop don't set NODE_ENV, so the fail-fast above is not the thing
 * that catches them.
 *
 * Module scope, so it prints at most once per process no matter how many modules import `config`.
 * The credentials are left out of the line: it names the target, it is not a copyable value.
 */
if (!isProduction && !process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL unset — using the local docker-compose default postgres://rfphub@localhost:5432/rfphub (no packages/api/.env found and nothing exported; copy .env-example to .env to point elsewhere).",
  );
}

const DEFAULT_PORT = 3001;

/**
 * A set-but-unusable PORT falls back to the default instead of binding somewhere nobody is talking
 * to. `Number("")` is 0, NOT NaN, so an empty or whitespace-only value — the normal shape of a
 * templated-but-unsupplied env var in a compose file or an orchestrator's config map — would
 * otherwise bind an OS-assigned ephemeral port while every probe still points at 3001. Anything
 * that is not a whole port number in 1..65535 is treated the same way.
 */
export function readPort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  const parsed = Number((raw ?? "").trim());
  const usable = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
  return usable ? parsed : fallback;
}

const DEFAULT_DB_POOL_MAX = 10;

/**
 * A set-but-unusable DB_POOL_MAX falls back to the default (pg's own default of 10) rather than
 * disabling the bound entirely — same defensive shape as `readPort`: `Number("")` is 0, NOT NaN,
 * so an empty or whitespace-only value must be treated the same as an invalid one.
 */
export function readDbPoolMax(raw: string | undefined, fallback = DEFAULT_DB_POOL_MAX): number {
  const parsed = Number((raw ?? "").trim());
  const usable = Number.isInteger(parsed) && parsed > 0;
  return usable ? parsed : fallback;
}

/**
 * PUBLIC_BASE_URL → the OpenAPI document's `servers[0].url`. Unlike PORT and DB_POOL_MAX, a wrong
 * value here has no safe fallback: it is a published contract, and silently serving `/` in its
 * place would hand every consumer a document that resolves against whatever host they happen to
 * have loaded. So this one REJECTS rather than falls back.
 *
 * - unset/blank → the relative `/` default, which is what local development runs with;
 * - `/` stays `/` — it is not an absolute URL and never reaches `new URL()`;
 * - anything else must parse as an absolute URL (a bare hostname is the common mistake, and it is
 *   an error, not a base URL);
 * - a trailing slash is stripped: `servers[0].url` is joined with paths that already start with
 *   `/`, so leaving it produces `//v1/opportunities`.
 * - the scheme must be `https:` for every host that is not loopback (see `isLoopbackHost`). This
 *   value is not merely how this process is reached — it is what the published document tells
 *   every client to use, so a plaintext remote origin downgrades all of them at once. The rule is
 *   about the transport, not about any particular domain, so it holds for a proxy, a preview
 *   environment and a vendor host alike.
 */
export function readPublicBaseUrl(raw: string | undefined, fallback = "/"): string {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  if (value === "/") return "/";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `PUBLIC_BASE_URL must be an absolute URL (e.g. https://api.example.org) or "/", got ${JSON.stringify(value)}.`,
    );
  }

  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `PUBLIC_BASE_URL must use https:// for any host that is not loopback — it is published as the OpenAPI document's servers[0].url, so it tells every client which scheme to use. Got ${JSON.stringify(value)}.`,
    );
  }

  return url.href.replace(/\/+$/, "");
}

// ── M3 readers ───────────────────────────────────────────────────────────────────────────────
//
// One reader per variable, each exported and unit-tested. The shared shape: a blank or absent
// value is "unset" and takes the default; a SET-but-unusable value takes the default too, EXCEPT
// where a wrong value is dangerous rather than merely wrong, in which case it throws at boot. The
// line between those two is drawn deliberately below, per variable.

/** A trimmed value, or undefined when absent/blank. Blank is unset — an unsubstituted template. */
export function readOptional(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  return value === "" ? undefined : value;
}

/**
 * A boolean flag. `1/true/yes/on` and `0/false/no/off`, case-insensitively; anything else — and
 * anything blank — is the default. Deliberately not `Boolean(raw)`, under which the string
 * `"false"` is true, which is the single most common way a feature flag lies.
 */
export function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

/** A whole number > 0, or the default. Same `Number("") === 0` trap as `readPort`. */
export function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A comma-separated list, trimmed, blanks dropped, duplicates removed, order preserved. */
export function readList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== ""),
    ),
  ];
}

/**
 * A PEM key from an environment variable.
 *
 * PEM is multi-line and most secret stores, task definitions and shells are happier with one line,
 * so `\n` written as two characters is the near-universal way this value arrives. Restoring the
 * newlines here means a key pasted either way verifies tokens, instead of failing with an opaque
 * parse error that looks like a wrong key.
 */
export function readPem(raw: string | undefined): string | undefined {
  const value = readOptional(raw);
  return value === undefined ? undefined : value.replace(/\\n/g, "\n");
}

const EMBEDDING_PROVIDERS: EmbeddingProvider[] = ["openai", "deterministic", "disabled"];

/**
 * Which embedding provider backs duplicate detection.
 *
 * The default is deliberately conservative in both directions: with an API key present, `openai`;
 * without one, `disabled` — never `deterministic`. The deterministic provider is a hashed token
 * bag: it is exactly right for CI, where dedupe tests must run without a credential, and it is not
 * a semantic model. Falling back to it silently would leave a deployment reporting duplicate
 * checks it is not really performing, which is worse than reporting none.
 */
export function readEmbeddingProvider(
  raw: string | undefined,
  apiKey: string | undefined,
): EmbeddingProvider {
  const value = (raw ?? "").trim().toLowerCase();
  if ((EMBEDDING_PROVIDERS as string[]).includes(value)) return value as EmbeddingProvider;
  if (value !== "") {
    throw new Error(
      `EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(", ")}, got ${JSON.stringify(raw)}.`,
    );
  }
  return apiKey === undefined ? "disabled" : "openai";
}

/**
 * Per-provider similarity defaults. A threshold is a property of an embedding space, not a
 * universal constant: the same number means different things to a 1536-dimension model and to a
 * hashed token bag, so one shared default would be wrong for at least one of them.
 *
 * `deterministic` is SETTLED at 0.74 — the midpoint of the separating band measured by
 * `scripts/dedupe-threshold-report.ts` over the committed corpus (worst positive 0.911, best
 * negative 0.571). `test/unit/dedupe-threshold.test.ts` asserts that band in CI, so a corpus change
 * that closes it fails the build rather than silently degrading detection.
 *
 * `openai` remains PROVISIONAL: settling it needs a key, which CI does not have and must not have,
 * so the number is a documented starting point rather than a measured one. See docs/data-model.md.
 */
export const DEFAULT_SIMILARITY_THRESHOLD: Record<EmbeddingProvider, number> = {
  openai: 0.86,
  deterministic: 0.74,
  disabled: 1,
};

/** A similarity threshold in [0, 1]. Out of range is meaningless rather than merely wrong. */
export function readSimilarityThreshold(
  raw: string | undefined,
  provider: EmbeddingProvider,
): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_SIMILARITY_THRESHOLD[provider];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `DEDUPE_SIMILARITY_THRESHOLD must be a cosine similarity in [0, 1], got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/**
 * The SSRF escape hatch, and the one reader that refuses rather than falls back.
 *
 * Enabling it lets the verifier fetch loopback, link-local and private addresses — which is what
 * one end-to-end test needs and what an attacker would need to reach the instance metadata
 * endpoint. There is no deployment in which that is the right setting, so under
 * `NODE_ENV=production` it is not a value that gets ignored: the process refuses to start, loudly,
 * rather than serving with the guard off.
 */
export function readAllowPrivateHosts(raw: string | undefined, production: boolean): boolean {
  const allow = readBoolean(raw, false);
  if (allow && production) {
    throw new Error(
      "VERIFY_ALLOW_PRIVATE_HOSTS is enabled under NODE_ENV=production. It disables the verifier's " +
        "SSRF address checks — including the block on the link-local metadata endpoint — and exists " +
        "only for one loopback test. Unset it.",
    );
  }
  return allow;
}

/**
 * What sits in front of this process, for `X-Forwarded-For` purposes.
 *
 * A hop count (`1`) or a CIDR/address list (`10.0.0.0/8,192.168.0.0/16`), passed through to
 * Fastify. `true` is REJECTED rather than accepted: it is the value everyone reaches for, and it
 * means "believe whatever the client claims its address is", which turns the analytics hash into
 * client-controlled input. Unset trusts nothing.
 */
export function readTrustProxy(raw: string | undefined): number | string[] | undefined {
  const value = (raw ?? "").trim();
  if (value === "") return undefined;
  if (["true", "false", "yes", "no"].includes(value.toLowerCase())) {
    throw new Error(
      `TRUST_PROXY is not a boolean: it names WHICH proxy to trust. Use a hop count (e.g. 1) or a comma-separated list of proxy addresses/CIDRs (e.g. 10.0.0.0/8). Got ${JSON.stringify(raw)}.`,
    );
  }
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) return hops;
  const list = readList(value);
  if (list.length === 0) {
    throw new Error(
      `TRUST_PROXY must be a hop count or an address list, got ${JSON.stringify(raw)}.`,
    );
  }
  return list;
}

/**
 * The analytics HMAC key.
 *
 * Unset is survivable, so it does not throw: a random per-boot key still keeps the hashes
 * unlinkable to an IP address, which is the privacy property. What it costs is continuity —
 * session de-duplication resets on every restart — so it warns, and says which of the two it is.
 * The key is never derived from anything in the image; see docs/deploy.md.
 */
export function readAnalyticsHmacKey(raw: string | undefined): {
  key: string;
  generated: boolean;
} {
  const value = readOptional(raw);
  if (value !== undefined) return { key: value, generated: false };
  return { key: randomBytes(32).toString("hex"), generated: true };
}

/** A secret this short is not a secret. Long enough that a guess is not a strategy. */
const SECRET_MIN_LENGTH = 32;

/**
 * The session-signing secret.
 *
 * PRODUCTION THROWS; everything else generates one per boot and says what that costs. The two
 * halves are different failures: a deployment without a secret would sign sessions with a value
 * that changes on every restart, so every deploy — and every scale event — would log every user
 * out, and nobody would connect the two. A developer's laptop doing the same is merely mildly
 * annoying, and demanding a secret to run the test suite would be friction for nothing.
 *
 * The length floor is checked with the same severity as absence: a two-character secret is the
 * failure that looks configured.
 */
export function readBetterAuthSecret(
  raw: string | undefined,
  production: boolean,
): { secret: string; configured: boolean } {
  const value = readOptional(raw);
  if (value !== undefined && value.length >= SECRET_MIN_LENGTH) {
    return { secret: value, configured: true };
  }
  if (production) {
    throw new Error(
      value === undefined
        ? `BETTER_AUTH_SECRET is required when NODE_ENV=production. It signs every session token; without it each restart would silently sign everyone out. Supply at least ${SECRET_MIN_LENGTH} random characters through the task definition's secrets.`
        : `BETTER_AUTH_SECRET must be at least ${SECRET_MIN_LENGTH} characters (got ${value.length}). It is the only thing standing between a forged token and a session.`,
    );
  }
  return { secret: randomBytes(32).toString("hex"), configured: false };
}

/**
 * The preview-origin predicate, as a source pattern.
 *
 * ANCHORED TO OUR PROJECT AND OUR TEAM, never a bare `*.vercel.app` — that would accept any tenant
 * on the platform, which is every attacker who can sign up. The residual trust is stated rather
 * than hidden: this assumes the preview host will not hand our team slug to somebody else.
 *
 * Supplied as a full regular expression by the deployment (staging only) so the exact shape stays a
 * deployment property; anchors are enforced here rather than trusted, because an unanchored pattern
 * matches in the middle of an attacker-chosen origin.
 */
export function readPreviewOriginPattern(raw: string | undefined): RegExp | undefined {
  const value = readOptional(raw);
  if (value === undefined) return undefined;
  if (!value.startsWith("^") || !value.endsWith("$")) {
    throw new Error(
      `PREVIEW_ORIGIN_PATTERN must be anchored with ^ and $ — an unanchored pattern matches inside an origin an attacker chooses (e.g. "https://evil.example/?x=${value}"). Got ${JSON.stringify(raw)}.`,
    );
  }
  try {
    return new RegExp(value);
  } catch (error) {
    throw new Error(
      `PREVIEW_ORIGIN_PATTERN is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Transports that only make sense on a developer's machine or in a test run. */
const LOCAL_ONLY_TRANSPORTS: ReadonlySet<string> = new Set(["file", "stdout", "memory", "null"]);
const EMAIL_TRANSPORTS: ReadonlySet<string> = new Set([
  "ses",
  "resend",
  "file",
  "stdout",
  "memory",
  "null",
]);

/**
 * How one-time codes are delivered.
 *
 * Refuses to boot in production on any transport that does not actually send an email, in the shape
 * `readAllowPrivateHosts` uses: a deployment whose sign-in codes go to a file nobody reads is not a
 * degraded deployment, it is a locked door, and it would present as "the code never arrived" for
 * every user at once.
 */
export function readEmailTransport(
  raw: string | undefined,
  production: boolean,
): EmailTransportKind {
  const value = (readOptional(raw) ?? (production ? "ses" : "stdout")).toLowerCase();
  if (!EMAIL_TRANSPORTS.has(value)) {
    throw new Error(
      `EMAIL_TRANSPORT must be one of ${[...EMAIL_TRANSPORTS].join(", ")}. Got ${JSON.stringify(raw)}.`,
    );
  }
  if (production && LOCAL_ONLY_TRANSPORTS.has(value)) {
    throw new Error(
      `EMAIL_TRANSPORT=${value} under NODE_ENV=production. Nothing would be delivered, so every sign-in would fail at the "enter the code" step with no error anywhere. Use ses.`,
    );
  }
  return value as EmailTransportKind;
}

const embeddingApiKey = readOptional(process.env.OPENAI_API_KEY);
const embeddingProvider = readEmbeddingProvider(process.env.EMBEDDING_PROVIDER, embeddingApiKey);
const analyticsHmac = readAnalyticsHmacKey(process.env.ANALYTICS_HMAC_KEY);
const betterAuthSecret = readBetterAuthSecret(process.env.BETTER_AUTH_SECRET, isProduction);
const emailTransport = readEmailTransport(process.env.EMAIL_TRANSPORT, isProduction);

export const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL ?? (isProduction ? "" : LOCAL_DATABASE_URL),
  port: readPort(process.env.PORT),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: readPublicBaseUrl(process.env.PUBLIC_BASE_URL),
  dbPoolMax: readDbPoolMax(process.env.DB_POOL_MAX),
  trustProxy: readTrustProxy(process.env.TRUST_PROXY),

  betterAuth: {
    secret: betterAuthSecret.secret,
    secretConfigured: betterAuthSecret.configured,
    // Falls back to this process's own address so a local run needs no configuration; a deployment
    // sets it to the API's public origin, which is what the OAuth callback is built from.
    url:
      readOptional(process.env.BETTER_AUTH_URL) ?? `http://127.0.0.1:${readPort(process.env.PORT)}`,
    trustedOrigins: readList(process.env.TRUSTED_ORIGINS),
    previewOriginPattern: readPreviewOriginPattern(process.env.PREVIEW_ORIGIN_PATTERN),
  },

  google: {
    clientId: readOptional(process.env.GOOGLE_CLIENT_ID),
    clientSecret: readOptional(process.env.GOOGLE_CLIENT_SECRET),
  },

  email: {
    transport: emailTransport,
    from: readOptional(process.env.EMAIL_FROM) ?? "no-reply@ethrfps.app",
    outboxDir: readOptional(process.env.EMAIL_OUTBOX_DIR),
    sesRegion: readOptional(process.env.AWS_SES_REGION) ?? readOptional(process.env.AWS_REGION),
    resendApiKey: readOptional(process.env.RESEND_API_KEY),
  },

  embedding: {
    provider: embeddingProvider,
    apiKey: embeddingApiKey,
    model: readOptional(process.env.EMBEDDING_MODEL) ?? "text-embedding-3-small",
    timeoutMs: readPositiveInt(process.env.EMBEDDING_TIMEOUT_MS, 5_000),
  },

  dedupe: {
    similarityThreshold: readSimilarityThreshold(
      process.env.DEDUPE_SIMILARITY_THRESHOLD,
      embeddingProvider,
    ),
    maxMatches: readPositiveInt(process.env.DEDUPE_MAX_MATCHES, 5),
  },

  verification: {
    enabled: readBoolean(process.env.VERIFICATION_ENABLED, true),
    // Default-on where it earns its keep and off under test, where a submission fixture must not
    // reach out to the network as a side effect of being created.
    onSubmit: readBoolean(process.env.VERIFY_ON_SUBMIT, process.env.NODE_ENV !== "test"),
    timeoutMs: readPositiveInt(process.env.VERIFY_TIMEOUT_MS, 10_000),
    maxBytes: readPositiveInt(process.env.VERIFY_MAX_BYTES, 2 * 1024 * 1024),
    queueMax: readPositiveInt(process.env.VERIFY_QUEUE_MAX, 100),
    allowPrivateHosts: readAllowPrivateHosts(process.env.VERIFY_ALLOW_PRIVATE_HOSTS, isProduction),
    egressProxy: readOptional(process.env.VERIFIER_EGRESS_PROXY),
  },

  analytics: {
    enabled: readBoolean(process.env.ANALYTICS_ENABLED, true),
    hmacKey: analyticsHmac.key,
    hmacKeyGenerated: analyticsHmac.generated,
    retentionDays: readPositiveInt(process.env.ANALYTICS_RETENTION_DAYS, 180),
  },

  stalenessInactiveDays: readPositiveInt(process.env.STALENESS_INACTIVE_DAYS, 90),
};

// Announced only where it costs something: a run with analytics off never touches the key, and a
// test run generates one on purpose. Both cases are noise, and noise is how a real warning gets
// missed.
// Said once, at boot, because the consequence is invisible until it bites: a per-boot secret means
// every restart invalidates every session, which presents to users as "it logged me out again" and
// to an operator as nothing at all.
if (!config.betterAuth.secretConfigured && process.env.NODE_ENV !== "test") {
  console.error(
    "BETTER_AUTH_SECRET unset (or shorter than 32 characters) — using a random per-boot secret. Sessions are signed with it, so EVERY RESTART SIGNS EVERYONE OUT. Set it in the environment; see packages/api/docs/deploy.md.",
  );
}

if (config.analytics.enabled && analyticsHmac.generated && process.env.NODE_ENV !== "test") {
  console.error(
    "ANALYTICS_HMAC_KEY unset — using a random per-boot key. The hashes stay unlinkable to an address either way; what is lost is continuity, so session de-duplication resets on every restart. Supply the key through the task definition's secrets (packages/api/docs/deploy.md).",
  );
}
