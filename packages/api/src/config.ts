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
export type EmailTransportKind =
  | "ses"
  | "resend"
  | "mailgun"
  | "file"
  | "stdout"
  | "memory"
  | "null";

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
  /** `mailgun` only. The HTTP Basic password; the user is the literal `api`. */
  mailgunApiKey: string | undefined;
  /**
   * `mailgun` only. The SENDING domain, which is a path segment of the send URL rather than
   * anything about the sender — it may legitimately differ from `from`'s domain, and normally does
   * (a subdomain carries the DKIM records so the apex keeps its own mail reputation).
   */
  mailgunDomain: string | undefined;
  /** `mailgun` only. Which regional endpoint the account lives on. Always set; see the reader. */
  mailgunApiBase: string;
}

export type EmbeddingProvider = "lexical" | "disabled";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
}

export interface DedupeConfig {
  /** Cosine similarity at or above which a pair is recorded as suspected. Per-provider. */
  similarityThreshold: number;
  maxMatches: number;
  /**
   * The second arm: length-corrected term overlap, which catches the re-listing that copies a
   * programme and publishes a shorter version of it. Cosine cannot — normalisation erases the
   * length difference that IS the signal. Off makes detection exactly what it was before.
   */
  overlapEnabled: boolean;
  /** Overlap at or above which a pair is suspected even though its cosine is not. Per-provider. */
  overlapThreshold: number;
  /** Distinct embedded tokens required on the SHORTER side before the overlap arm may fire. */
  overlapMinTokens: number;
  /** Cosine floor under which the overlap arm is not evaluated at all. */
  overlapMinSimilarity: number;
}

export interface VerificationConfig {
  enabled: boolean;
  onSubmit: boolean;
  timeoutMs: number;
  maxBytes: number;
  queueMax: number;
  /**
   * How many runs per entry survive the backfill's prune. A run carries up to 200 KB of
   * `snapshot_text`, so an unpruned log is the largest thing this feature writes.
   */
  runsKeep: number;
  /**
   * How old a `verified_at` may be before the backfill checks the entry again. Without it an entry
   * is checked exactly once and the corpus's "still real" signal decays to nothing.
   */
  recheckDays: number;
  /** Entries one backfill invocation will check. Bounds the nightly run's wall clock. */
  nightlyLimit: number;
  /**
   * The minimum gap between two backfill fetches to the SAME host (`host-pacer.ts`).
   *
   * A SETTING RATHER THAN A CONSTANT because it is the one number that decides how long a pass
   * takes, and because zero is a legitimate value for a deployment whose only source host is its
   * own: the e2e stack points every fixture at one disposable server it started itself, and paying
   * a real second of politeness to a process this repository owns buys nothing and costs the suite
   * a minute. Production leaves it at the default; nothing in a deployment should set it to 0.
   */
  hostGapMs: number;
  /** SSRF escape hatch for one loopback test. Refused outright under NODE_ENV=production. */
  allowPrivateHosts: boolean;
  egressProxy: string | undefined;
}

export interface NotificationConfig {
  /** Waiting email attempts retained by the post-commit, in-process dispatcher. */
  queueMax: number;
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
  /** The frontend origin used for absolute links in outbound email. */
  appBaseUrl: string;
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
  notifications: NotificationConfig;
  analytics: AnalyticsConfig;
  /** Days of no publisher touch after which a deadline-less open entry is closed as inactive. */
  stalenessInactiveDays: number;
  /**
   * How many entries one account may leave awaiting review at once, when it holds no verified
   * membership anywhere. A queue is a shared resource: without a ceiling, one account can fill it.
   */
  pendingSubmissionLimit: number;
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

/**
 * APP_BASE_URL names the ONE frontend origin safe to publish in outbound email.
 *
 * It cannot be inferred from `PUBLIC_BASE_URL` (the API origin) or from `TRUSTED_ORIGINS` (an
 * allowlist that may contain API, preview and local origins). Production therefore requires it;
 * local development has the frontend's ordinary localhost origin as an explicit fallback.
 */
export function readAppBaseUrl(
  raw: string | undefined,
  production: boolean,
  fallback = "http://localhost:3005",
): string {
  const value = readOptional(raw);
  if (value === undefined) {
    if (production) {
      throw new Error(
        "APP_BASE_URL is required under NODE_ENV=production so outbound email never guesses which frontend origin to publish.",
      );
    }
    return fallback;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `APP_BASE_URL must be an absolute frontend origin (e.g. https://app.example.org), got ${JSON.stringify(raw)}.`,
    );
  }

  if (url.protocol !== "https:" && (url.protocol !== "http:" || !isLoopbackHost(url.hostname))) {
    throw new Error(
      `APP_BASE_URL must use https:// for any host that is not loopback, got ${JSON.stringify(raw)}.`,
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `APP_BASE_URL must be an origin with no path, credentials, query or fragment, got ${JSON.stringify(raw)}.`,
    );
  }
  return url.origin;
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

/**
 * A whole number >= 0, or the default. Separate from `readPositiveInt` because ZERO IS A MEANING
 * here rather than a typo: it is how a deployment says "do not do this at all" for a setting whose
 * unit is a delay, and `readPositiveInt` would silently hand back the default instead.
 *
 * THE BLANK CHECK IS NOT REDUNDANT, and it is the whole reason this cannot be a one-line copy of
 * `readPositiveInt`. `Number("")` is `0`, an integer, and >= 0 — so a variable that is unset, or
 * set to an unsubstituted template that trimmed to nothing, would read as a deliberate "no delay"
 * and silently turn the pacing off in production. The predicate that hides that trap for a
 * positive-only reader is exactly the one this reader gives up.
 */
export function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

const EMBEDDING_PROVIDERS: EmbeddingProvider[] = ["lexical", "disabled"];

/**
 * Which duplicate detector backs the dedupe pass.
 *
 * `lexical` is the in-process TF-IDF featurizer — no key, no network, nothing to be absent — and
 * it is the default when nothing is configured: the silent-fallback rule this reader used to
 * enforce existed because the credential-free provider was once a CI stand-in rather than the
 * detector, and both halves of that sentence have stopped being true. `disabled` stays available
 * for a deployment that wants detection off, and it must be ASKED for.
 *
 * `openai` is REFUSED BY NAME rather than ignored: a deployment still carrying the old value
 * asked for a hosted semantic model, and silently handing it a different detector — or silently
 * detecting nothing — are both worse than a boot error with a one-line fix. `deterministic` is
 * accepted as a deprecated alias for one release: it names the same computation family, so no
 * deployment is harmed by the mapping, and the alias goes away next release.
 */
export function readEmbeddingProvider(raw: string | undefined): EmbeddingProvider {
  const value = (raw ?? "").trim().toLowerCase();
  if ((EMBEDDING_PROVIDERS as string[]).includes(value)) return value as EmbeddingProvider;
  if (value === "deterministic") return "lexical";
  if (value === "openai") {
    throw new Error(
      "EMBEDDING_PROVIDER=openai is no longer supported: duplicate detection runs on the in-process lexical featurizer and sends nothing to any AI vendor. Set EMBEDDING_PROVIDER=lexical (or unset it — lexical is the default), and remove OPENAI_API_KEY from the environment.",
    );
  }
  if (value !== "") {
    throw new Error(
      `EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(", ")}, got ${JSON.stringify(raw)}.`,
    );
  }
  return "lexical";
}

/**
 * Per-provider similarity defaults. A threshold is a property of an embedding space, not a
 * universal constant — one provider today does not mean one provider forever, and this shape is
 * where that insight is recorded.
 *
 * `lexical` is SETTLED at 0.75 — the midpoint of the separating band measured by
 * `scripts/dedupe-threshold-report.ts` over EVERY distinct pair of the committed corpus (worst
 * positive 0.913, hardest of 12 720 corpus negatives 0.592). `test/unit/dedupe-threshold.test.ts`
 * asserts that band in CI, so a corpus change that closes it fails the build rather than silently
 * degrading detection.
 */
export const DEFAULT_SIMILARITY_THRESHOLD: Record<EmbeddingProvider, number> = {
  lexical: 0.75,
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
 * Per-provider defaults for the OVERLAP arm, mirroring `DEFAULT_SIMILARITY_THRESHOLD` for the
 * same reason: a length-corrected overlap means something different in every weighting.
 *
 * `lexical` is settled at **0.85**, measured by `scripts/dedupe-threshold-report.ts` over every
 * distinct pair of the committed corpus with the same substance guard the runtime applies:
 *
 * | | full corpus | held out (idf from one half, scored on the other) |
 * |---|---|---|
 * | hardest negative overlap | 0.682 | 0.750 |
 * | worst positive overlap | 0.956 | 0.945 |
 * | band | 0.274 | 0.195 |
 *
 * 0.85 is inside both bands and on the edge of neither: +0.168 above the hardest full-corpus
 * negative, −0.106 below the worst positive; +0.100 / −0.095 out of sample.
 *
 * `disabled` is **4**, not 1 — see `readOverlapThreshold`, overlap is not bounded by 1, so 1 would
 * be a reachable value rather than an unreachable one.
 */
export const DEFAULT_OVERLAP_THRESHOLD: Record<EmbeddingProvider, number> = {
  lexical: 0.85,
  disabled: 4,
};

/**
 * An overlap threshold in **(0, 4]** — deliberately NOT `[0, 1]`.
 *
 * Overlap is cosine corrected by the norm ratio, and it is not bounded by 1: a shorter side made
 * of the longer side's highest-weight terms measures above 1 (1.223 on an honest 40 % truncation
 * of a real corpus entry, 1.543 on a cherry-picked stub). A `[0, 1]` range copied from
 * `readSimilarityThreshold` would refuse legitimate operating points and, worse, would encode the
 * false claim that this number is a proportion. Zero is refused because it accepts everything the
 * cosine floor lets through, which is not a configuration anybody means.
 *
 * Out of range REFUSES rather than clamps: a clamped threshold is a detector running at a setting
 * nobody chose.
 */
export function readOverlapThreshold(raw: string | undefined, provider: EmbeddingProvider): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_OVERLAP_THRESHOLD[provider];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4) {
    throw new Error(
      `DEDUPE_OVERLAP_THRESHOLD must be a length-corrected overlap in (0, 4] — it is cosine times a norm ratio and is NOT bounded by 1 — got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/**
 * The overlap arm's cosine floor, in [0, 1].
 *
 * NOT A SECURITY CONTROL, and the doc comment says so because the name invites the opposite
 * reading. Arm B is only ever evaluated on ANN candidates, which are already cosine-ordered; this
 * makes that implicit dependency explicit and configurable. Raising it 0.35 → 0.55 was measured to
 * change the stub attack not at all — the attacker simply uses a larger stub. The guard that works
 * is `DEDUPE_OVERLAP_MIN_TOKENS`.
 */
export function readOverlapMinSimilarity(raw: string | undefined, fallback: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `DEDUPE_OVERLAP_MIN_SIMILARITY must be a cosine similarity in [0, 1], got ${JSON.stringify(raw)}.`,
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
  "mailgun",
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
      `EMAIL_TRANSPORT=${value} under NODE_ENV=production. Nothing would be delivered, so every sign-in would fail at the "enter the code" step with no error anywhere. Use ses or mailgun.`,
    );
  }
  return value as EmailTransportKind;
}

const DEFAULT_MAILGUN_API_BASE = "https://api.mailgun.net";

/**
 * Which Mailgun endpoint the account lives on.
 *
 * It exists because the US and EU regions are DIFFERENT HOSTS (`api.mailgun.net` and
 * `api.eu.mailgun.net`) holding different accounts: sending an EU account's domain to the US host
 * is not a slow path, it is a 401 on every message. The default is the US host, which is where an
 * account is unless somebody chose otherwise at signup.
 *
 * Validated in the spirit of `readPublicBaseUrl` rather than falling back, because the fallback
 * would be the wrong region and would present as "the code never arrived": it must parse as an
 * absolute URL and the trailing slash is stripped (the send path is appended and already starts
 * with `/`).
 *
 * The SCHEME IS ALLOW-LISTED, not merely required to be https off loopback. Two different things
 * are being refused and the loopback exemption only covers one of them: `http:` is refused remotely
 * because the request carries the API key in an `Authorization` header and plaintext would publish
 * it — which loopback traffic, never leaving the machine, genuinely escapes, so a test double may
 * be a local http server. But `ftp://localhost` or `ws://127.0.0.1` is not a privacy question at
 * all: `fetch` cannot send to either, from anywhere, so accepting one at boot buys a configuration
 * that looks fine until the first sign-in fails inside a detached promise. So: `https:` anywhere,
 * `http:` on loopback, nothing else.
 *
 * It is also an ORIGIN, optionally with a path prefix, and nothing else — because the send URL is
 * built by CONCATENATION (`${base}/v3/${domain}/messages`), and the components refused below each
 * survive that in their own wrong way: a query absorbs the path into itself
 * (`…net?x=1/v3/…/messages` is one query string, not a route), a fragment leaves the request on
 * `/`, and userinfo makes `fetch` throw outright. All three parse cleanly, so none of them is
 * caught by anything above — and all three boot a deployment that delivers no mail at all. A plain
 * path prefix, which is what a proxy in front of the account looks like, stays allowed.
 */
export function readMailgunApiBase(
  raw: string | undefined,
  fallback = DEFAULT_MAILGUN_API_BASE,
): string {
  const value = readOptional(raw);
  if (value === undefined) return fallback;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `MAILGUN_API_BASE must be an absolute URL (e.g. ${DEFAULT_MAILGUN_API_BASE}, or https://api.eu.mailgun.net for an EU account), got ${JSON.stringify(value)}.`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `MAILGUN_API_BASE must be an https:// URL — the send is an HTTPS request, and nothing else is a scheme it could be made over. Got ${JSON.stringify(value)}.`,
    );
  }

  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `MAILGUN_API_BASE must use https:// for any host that is not loopback — every send carries the API key in an Authorization header, and plaintext would publish it to the network. Got ${JSON.stringify(value)}.`,
    );
  }

  const carried = [
    url.username !== "" || url.password !== "" ? "credentials" : undefined,
    url.search !== "" ? "a query string" : undefined,
    url.hash !== "" ? "a fragment" : undefined,
  ].filter((part): part is string => part !== undefined);

  if (carried.length > 0) {
    throw new Error(
      `MAILGUN_API_BASE carries ${carried.join(" and ")}, and it must be an origin (optionally with a path prefix): the send path is appended to it, so a query string swallows that path, a fragment sends the request to / instead, and credentials make the request throw. Each of those boots normally and then delivers nothing. Got ${JSON.stringify(value)}.`,
    );
  }

  return url.href.replace(/\/+$/, "");
}

/**
 * The boot-time noise for a half-configured Mailgun pair — a WARNING, never a refusal.
 *
 * It used to refuse the boot, and that was the wrong coupling: a mail secret missing half its pair
 * crash-looped the whole service, holding the public read surface hostage to an email credential.
 * Completeness is judged where it matters instead — `deliversEmail()` answers false for an
 * incomplete pair, the four code-sending routes refuse with an explicit 503, and everything that
 * sends nothing keeps serving. The moment both keys reach the environment, the same build delivers
 * — no code change. This function is the replacement noise, in the shape of this file's other
 * warnings: said once, loudly, naming exactly the key(s) that fix it. The local-only transports
 * (`file`/`stdout`/`memory`/`null`) keep their production refusal in `readEmailTransport` — codes
 * going to a file nobody reads is a misconfiguration with no valid interim state, a different
 * class entirely.
 */
export function mailgunCredentialWarning(email: {
  transport: EmailTransportKind;
  mailgunApiKey: string | undefined;
  mailgunDomain: string | undefined;
}): string | undefined {
  if (email.transport !== "mailgun") return undefined;
  const missing = [
    email.mailgunApiKey === undefined ? "MAILGUN_API_KEY" : undefined,
    email.mailgunDomain === undefined ? "MAILGUN_DOMAIN" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length === 0) return undefined;
  return `EMAIL_TRANSPORT=mailgun without ${missing.join(" and ")} — the transport is configured but cannot authenticate, so sign-in code delivery is DISABLED: the code-sending routes answer 503 until the missing key(s) reach the environment, and everything that does not send email keeps serving. Supply them through the task definition's secrets (packages/api/docs/deploy.md).`;
}

const embeddingProvider = readEmbeddingProvider(process.env.EMBEDDING_PROVIDER);
const analyticsHmac = readAnalyticsHmacKey(process.env.ANALYTICS_HMAC_KEY);
const betterAuthSecret = readBetterAuthSecret(process.env.BETTER_AUTH_SECRET, isProduction);
const emailTransport = readEmailTransport(process.env.EMAIL_TRANSPORT, isProduction);

export const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL ?? (isProduction ? "" : LOCAL_DATABASE_URL),
  port: readPort(process.env.PORT),
  host: process.env.HOST ?? "0.0.0.0",
  appBaseUrl: readAppBaseUrl(process.env.APP_BASE_URL, isProduction),
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
    mailgunApiKey: readOptional(process.env.MAILGUN_API_KEY),
    mailgunDomain: readOptional(process.env.MAILGUN_DOMAIN),
    mailgunApiBase: readMailgunApiBase(process.env.MAILGUN_API_BASE),
  },

  embedding: {
    provider: embeddingProvider,
  },

  dedupe: {
    similarityThreshold: readSimilarityThreshold(
      process.env.DEDUPE_SIMILARITY_THRESHOLD,
      embeddingProvider,
    ),
    maxMatches: readPositiveInt(process.env.DEDUPE_MAX_MATCHES, 5),
    overlapEnabled: readBoolean(process.env.DEDUPE_OVERLAP_ENABLED, true),
    overlapThreshold: readOverlapThreshold(process.env.DEDUPE_OVERLAP_THRESHOLD, embeddingProvider),
    // 20 distinct tokens on the shorter side. The only guard measured to work against the stub
    // attack, and it costs nothing on real negatives — the hardest stays 0.682 at every setting —
    // while every mutation rung clears it with at least 16 tokens spare. The attack numbers are
    // printed by `scripts/dedupe-threshold-report.ts` and pinned by `test/unit/
    // dedupe-threshold.test.ts`, so they are measured on every run rather than quoted here.
    overlapMinTokens: readPositiveInt(process.env.DEDUPE_OVERLAP_MIN_TOKENS, 20),
    overlapMinSimilarity: readOverlapMinSimilarity(process.env.DEDUPE_OVERLAP_MIN_SIMILARITY, 0.35),
  },

  verification: {
    enabled: readBoolean(process.env.VERIFICATION_ENABLED, true),
    // Default-on where it earns its keep and off under test, where a submission fixture must not
    // reach out to the network as a side effect of being created.
    onSubmit: readBoolean(process.env.VERIFY_ON_SUBMIT, process.env.NODE_ENV !== "test"),
    timeoutMs: readPositiveInt(process.env.VERIFY_TIMEOUT_MS, 10_000),
    maxBytes: readPositiveInt(process.env.VERIFY_MAX_BYTES, 2 * 1024 * 1024),
    queueMax: readPositiveInt(process.env.VERIFY_QUEUE_MAX, 100),
    runsKeep: readPositiveInt(process.env.VERIFICATION_RUNS_KEEP, 5),
    recheckDays: readPositiveInt(process.env.VERIFY_RECHECK_DAYS, 30),
    nightlyLimit: readPositiveInt(process.env.VERIFY_NIGHTLY_LIMIT, 500),
    // The literal, rather than an import of `HOST_MIN_GAP_MS`: config is the bottom of the graph
    // and does not reach up into a service module for a number. `config.test.ts` asserts the two
    // agree, so the duplication cannot drift.
    hostGapMs: readNonNegativeInt(process.env.VERIFY_HOST_MIN_GAP_MS, 1_000),
    allowPrivateHosts: readAllowPrivateHosts(process.env.VERIFY_ALLOW_PRIVATE_HOSTS, isProduction),
    egressProxy: readOptional(process.env.VERIFIER_EGRESS_PROXY),
  },

  notifications: {
    queueMax: readPositiveInt(process.env.NOTIFICATION_QUEUE_MAX, 100),
  },

  analytics: {
    enabled: readBoolean(process.env.ANALYTICS_ENABLED, true),
    hmacKey: analyticsHmac.key,
    hmacKeyGenerated: analyticsHmac.generated,
    retentionDays: readPositiveInt(process.env.ANALYTICS_RETENTION_DAYS, 180),
  },

  stalenessInactiveDays: readPositiveInt(process.env.STALENESS_INACTIVE_DAYS, 90),
  // A product rule, not a deployment knob: a ceiling on the QUEUE, not a quota on a lifetime — every
  // approval or rejection frees a slot, and replacing an entry that is already pending is not a new
  // submission. Anybody holding a verified publisher membership anywhere is exempt entirely: their
  // own writes auto-approve and never reach the queue. Fixed at 5 by decision, so it cannot be
  // raised quietly by an operator holding only the deployment configuration.
  pendingSubmissionLimit: 5,
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

const mailgunWarning = mailgunCredentialWarning(config.email);
if (mailgunWarning !== undefined && process.env.NODE_ENV !== "test") {
  console.error(mailgunWarning);
}

if (config.analytics.enabled && analyticsHmac.generated && process.env.NODE_ENV !== "test") {
  console.error(
    "ANALYTICS_HMAC_KEY unset — using a random per-boot key. The hashes stay unlinkable to an address either way; what is lost is continuity, so session de-duplication resets on every restart. Supply the key through the task definition's secrets (packages/api/docs/deploy.md).",
  );
}
