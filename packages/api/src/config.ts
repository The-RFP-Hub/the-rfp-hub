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

/** Access-token verification and the optional server-side enrichment credential. */
export interface PrivyConfig {
  /** The app id. Also the token `aud`, so a token minted for another app is rejected. */
  appId: string | undefined;
  /** The app's PEM verification key — the documented mechanism for app access tokens. */
  verificationKey: string | undefined;
  /** An UNVERIFIED override: no JWKS endpoint is documented for app access tokens. */
  jwksUrl: string | undefined;
  /** Server-side secret. Enrichment only, never the auth path. Absent → enrichment is inert. */
  appSecret: string | undefined;
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
  privy: PrivyConfig;
  embedding: EmbeddingConfig;
  dedupe: DedupeConfig;
  verification: VerificationConfig;
  analytics: AnalyticsConfig;
  /**
   * Accounts that become admins on login, matched by DID. Re-evaluated on EVERY login, so adding
   * one takes effect without touching the database.
   */
  bootstrapAdminPrivyDids: string[];
  /**
   * The same, matched against a wallet the identity provider has VERIFIED — never a wallet the
   * request asserts. Inert without `privy.appSecret`, since nothing fills the verified wallet in.
   */
  bootstrapAdminWallets: string[];
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
 * Both are PROVISIONAL operating points, to be settled against the committed corpus by the
 * threshold sweep (`scripts/dedupe-threshold-report.ts`) and recorded in docs/data-model.md.
 */
export const DEFAULT_SIMILARITY_THRESHOLD: Record<EmbeddingProvider, number> = {
  openai: 0.86,
  deterministic: 0.72,
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

const embeddingApiKey = readOptional(process.env.OPENAI_API_KEY);
const embeddingProvider = readEmbeddingProvider(process.env.EMBEDDING_PROVIDER, embeddingApiKey);
const analyticsHmac = readAnalyticsHmacKey(process.env.ANALYTICS_HMAC_KEY);

export const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL ?? (isProduction ? "" : LOCAL_DATABASE_URL),
  port: readPort(process.env.PORT),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: readPublicBaseUrl(process.env.PUBLIC_BASE_URL),
  dbPoolMax: readDbPoolMax(process.env.DB_POOL_MAX),
  trustProxy: readTrustProxy(process.env.TRUST_PROXY),

  privy: {
    appId: readOptional(process.env.PRIVY_APP_ID),
    verificationKey: readPem(process.env.PRIVY_VERIFICATION_KEY),
    jwksUrl: readOptional(process.env.PRIVY_JWKS_URL),
    appSecret: readOptional(process.env.PRIVY_APP_SECRET),
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

  bootstrapAdminPrivyDids: readList(process.env.BOOTSTRAP_ADMIN_PRIVY_DIDS),
  // Lowercased because an address is case-insensitive in every form that matters here, and a
  // checksummed paste must not silently fail to match the same address written flat.
  bootstrapAdminWallets: readList(process.env.BOOTSTRAP_ADMIN_WALLETS).map((w) => w.toLowerCase()),
  stalenessInactiveDays: readPositiveInt(process.env.STALENESS_INACTIVE_DAYS, 90),
};

// Announced only where it costs something: a run with analytics off never touches the key, and a
// test run generates one on purpose. Both cases are noise, and noise is how a real warning gets
// missed.
if (config.analytics.enabled && analyticsHmac.generated && process.env.NODE_ENV !== "test") {
  console.error(
    "ANALYTICS_HMAC_KEY unset — using a random per-boot key. The hashes stay unlinkable to an address either way; what is lost is continuity, so session de-duplication resets on every restart. Supply the key through the task definition's secrets (packages/api/docs/deploy.md).",
  );
}

// Said once, at boot, because the alternative is a variable that looks set and does nothing.
if (config.bootstrapAdminWallets.length > 0 && config.privy.appSecret === undefined) {
  console.error(
    "BOOTSTRAP_ADMIN_WALLETS is set but PRIVY_APP_SECRET is not, so no wallet is ever verified and the list matches nothing. Use BOOTSTRAP_ADMIN_PRIVY_DIDS, which needs no enrichment.",
  );
}
