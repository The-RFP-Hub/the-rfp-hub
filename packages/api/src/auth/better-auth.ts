/**
 * The session authority: one Better-Auth instance, composed here and nowhere else.
 *
 * WHAT THIS DEPLOYMENT ACTUALLY USES — and, as importantly, what it deliberately does not:
 *
 *   `emailOTP`      the only way in. No password store, so no reset flow, no strength policy, no
 *                   credential-stuffing surface, and nothing to leak. Holding an address means
 *                   controlling the mailbox, which is the same proof a password reset ends at.
 *   `bearer`        `Authorization: Bearer <token>` on `/v1`, which is what keeps the whole API
 *                   header-authenticated and therefore free of CSRF and of `credentials:true` CORS.
 *                   `requireSignature: true` because the HMAC is checked BEFORE any database
 *                   access: a forged or foreign-deployment token costs one hash, not a query.
 *   `oneTimeToken`  the OAuth→bearer hop only (`/api/auth-handoff`). `disableClientRequest: true`
 *                   closes the client-facing mint: nothing but our own server-side handoff has any
 *                   business creating one.
 *
 * NO `jwt` PLUGIN. A JWT would put a second credential format under the same header and buy a
 * stale-until-expiry window in exchange for a database read we already pay for elsewhere. Session
 * revocation is immediate here because the session IS the row — signing out deletes it.
 *
 * ROTATING THE SECRET SIGNS EVERYONE OUT. The bearer path HMACs against exactly one value; there is
 * no dual-secret verification. That is a documented property, not an oversight — see
 * `config.ts:readBetterAuthSecret` and docs/auth.md.
 */
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, oneTimeToken } from "better-auth/plugins";
import type { BetterAuthConfig, EmailConfig, GoogleConfig } from "../config.js";
import { config as defaultConfig } from "../config.js";
import { authAccount, authSession, authUser, authVerification } from "../db/auth-schema.js";
import { type DB, db as defaultDb } from "../db/client.js";
import { AccountService } from "../modules/services/auth/account.service.js";
import { deliversEmail } from "../modules/services/email/email-transport.js";
import {
  EmailService,
  type OutboundEmailPort,
  recipientFingerprint,
} from "../modules/services/email/email.service.js";
import {
  type NotificationDispatchEnqueuer,
  NotificationDispatchQueue,
} from "../modules/services/notifications/notification-dispatch.queue.js";
import { NotificationDispatchService } from "../modules/services/notifications/notification-dispatch.service.js";

/** Exactly the configuration this module reads — so a test can build one without the whole app's. */
export interface AuthConfig {
  betterAuth: BetterAuthConfig;
  google: GoogleConfig;
  email: EmailConfig;
  /** Frontend origin used by lifecycle-email links, injected from the same runtime config. */
  appBaseUrl: string;
}

/** The deployment's own auth-side configuration, as the slice this module and the mount read. */
export function authConfigFromEnvironment(): AuthConfig {
  return {
    betterAuth: defaultConfig.betterAuth,
    google: defaultConfig.google,
    email: defaultConfig.email,
    appBaseUrl: defaultConfig.appBaseUrl,
  };
}

/**
 * Just enough of a logger to report a delivery failure — pino's shape, which is Fastify's, so the
 * deployment's own logger can be handed in unchanged.
 */
export interface AuthLogger {
  error(payload: Record<string, unknown>, message: string): void;
}

const consoleLogger: AuthLogger = {
  error(payload, message) {
    console.error(message, JSON.stringify(payload));
  },
};

export interface CreateAuthOptions {
  db?: DB;
  config?: AuthConfig;
  /** Test/composition seam. Production uses the central email service from configuration. */
  email?: OutboundEmailPort;
  /** Where a delivery failure is reported. Defaults to stderr, which is what the deployment reads. */
  logger?: AuthLogger;
  /** Test/composition seam for the bounded post-commit lifecycle-email accelerator. */
  notificationQueue?: NotificationDispatchEnqueuer;
  production?: boolean;
}

/** 90 days, refreshed at most once a day. Owner decision: people should not be logged out. */
const SESSION_EXPIRES_IN = 60 * 60 * 24 * 90;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

/** Six digits, five minutes, three guesses. */
const OTP_LENGTH = 6;
const OTP_EXPIRES_IN = 300;
const OTP_ALLOWED_ATTEMPTS = 3;

/**
 * THE ONE HEADER THE AUTH LIBRARY READS A CLIENT ADDRESS FROM, and nobody outside this process
 * writes it.
 *
 * Left to its defaults the library reads `X-Forwarded-For` straight off the request. A caller who
 * sends their own `X-Forwarded-For` reaches us with two values in it (theirs, then the load
 * balancer's), the library trusts only single-value headers, and every such request resolves to
 * "no address" — one shared `no-trusted-ip` bucket per route. Anyone could spend that bucket and
 * lock out sign-in for everybody else who arrives with a multi-value header.
 *
 * So the mount (`plugins/better-auth.ts`, `toWebRequest`) drops every forwarding header the caller
 * sent, drops this one too if the caller tried it, and sets this one to `request.ip` — the address
 * Fastify already resolved under `TRUST_PROXY`, the same one the `/v1` limiters key on. The library
 * is told to read this header and nothing else.
 */
export const CLIENT_IP_HEADER = "x-rfphub-client-ip";

/**
 * The library's own limiter, WRITTEN OUT.
 *
 * It is on by default only under `NODE_ENV=production`, with rules that live in two places in the
 * dependency (its defaults and the email-OTP plugin's). Declared here so the numbers are a decision
 * in this file and hold in every environment. Keys are the library's paths, relative to
 * `/api/auth`. These sit BEHIND the mount's own address-keyed Fastify ceilings (10/min for the
 * mail-sending routes, 120/min for the rest), and are tighter only where a code is involved:
 *
 *   sending a code   3 per 5 minutes per address — a person asks for a code, maybe twice. The
 *                    library's default was 3 per minute.
 *   checking a code  10 per 5 minutes per address — room for typos across a few codes; each code
 *                    still dies after OTP_ALLOWED_ATTEMPTS wrong guesses. Default was 3 per minute.
 *
 * Everything else keeps the library's defaults: the general 100 per 10 s, restated here so a
 * dependency bump cannot move it silently, and the library's built-in 3 per 10 s on `/sign-in*`,
 * `/sign-up*`, `/change-password*` and `/change-email*` (the OAuth sign-in start among them).
 *
 * IN MEMORY, PER PROCESS — the same as every other limiter in this API (`docs/auth.md`, "The
 * ceilings are per PROCESS"). `storage: "database"` would need a `rateLimit` table and a migration.
 */
export const OTP_SEND_RATE_LIMIT = { window: 300, max: 3 } as const;
export const OTP_CHECK_RATE_LIMIT = { window: 300, max: 10 } as const;
export const OTP_SEND_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/request-email-change",
] as const;
export const OTP_CHECK_PATHS = [
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/reset-password",
  "/email-otp/change-email",
] as const;

/**
 * ON IN EVERY ENVIRONMENT unless `AUTH_RATE_LIMIT_ENABLED=false`, which `config.ts` refuses under
 * `NODE_ENV=production`. The one stack that turns it off is the e2e runner: it signs in a dozen
 * identities from 127.0.0.1 in a few minutes, and now that a caller cannot pick its own address
 * (the point of `CLIENT_IP_HEADER`) it has no other way to be several people.
 */
export function authRateLimit(enabled: boolean) {
  return {
    enabled,
    storage: "memory",
    window: 10,
    max: 100,
    customRules: Object.fromEntries([
      ...OTP_SEND_PATHS.map((path) => [path, { ...OTP_SEND_RATE_LIMIT }]),
      ...OTP_CHECK_PATHS.map((path) => [path, { ...OTP_CHECK_RATE_LIMIT }]),
    ]),
  } satisfies BetterAuthOptions["rateLimit"];
}

/**
 * The origins allowed to drive sign-in — CSRF, `callbackURL`, the handoff redirect and the
 * `/api/auth/*` CORS allowlist, all from this one list so they cannot drift apart.
 *
 * The library takes a FUNCTION returning a list rather than a predicate, so a preview origin is
 * admitted by echoing the request's own `Origin` back when — and only when — it matches the
 * anchored pattern. That is the same decision a predicate would make, expressed in the shape the
 * option actually has, and it never widens to a bare wildcard.
 */
export function allowedOrigins(cfg: BetterAuthConfig, request?: Request): string[] {
  const origin = request?.headers.get("origin") ?? undefined;
  const preview =
    origin !== undefined && cfg.previewOriginPattern?.test(origin) === true ? [origin] : [];
  return [...cfg.trustedOrigins, ...preview];
}

/** Whether this exact origin may drive sign-in. The CORS half of the same question. */
export function isAllowedOrigin(cfg: BetterAuthConfig, origin: string | undefined): boolean {
  if (origin === undefined) return false;
  return cfg.trustedOrigins.includes(origin) || cfg.previewOriginPattern?.test(origin) === true;
}

/**
 * Whether the Google provider is registered at all.
 *
 * Both halves are required: a client id with no secret cannot complete a callback, so registering
 * the provider on the id alone would advertise a sign-in method that fails at the last step. The
 * health endpoint reads the SAME predicate the composition below does, so what the API advertises
 * and what it actually mounts cannot drift.
 */
export function googleConfigured(cfg: GoogleConfig): boolean {
  return cfg.clientId !== undefined && cfg.clientSecret !== undefined;
}

export function createAuth(options: CreateAuthOptions = {}) {
  const db = options.db ?? defaultDb;
  const cfg = options.config ?? defaultConfig;
  const production = options.production ?? process.env.NODE_ENV === "production";
  const outboundEmail = options.email ?? new EmailService({ config: cfg.email, production });
  const logger = options.logger ?? consoleLogger;
  // Auth may be composed over a test database, transport and config. Build the accelerator from
  // those exact seams rather than using the process-global queue, while keeping durable rows and
  // the nightly dispatcher as the source of truth if this bounded queue is full or the process
  // exits before its fire-and-forget attempt completes.
  const accountNotificationQueue =
    options.notificationQueue ??
    new NotificationDispatchQueue({
      dispatcher: new NotificationDispatchService(db, {
        email: outboundEmail,
        appBaseUrl: cfg.appBaseUrl,
        unsubscribe: { apiBaseUrl: cfg.betterAuth.url, secret: cfg.betterAuth.secret },
        enabled: deliversEmail(cfg.email),
        logger,
      }),
    });
  const accountService = new AccountService(db, logger, accountNotificationQueue);
  const google = googleConfigured(cfg.google);

  return betterAuth({
    // The adapter matches MODEL names against this object's KEYS, which is what lets the tables
    // themselves be `auth_*` (see src/db/auth-schema.ts) without the library knowing.
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    secret: cfg.betterAuth.secret,
    baseURL: cfg.betterAuth.url,
    basePath: "/api/auth",
    trustedOrigins: (request) => allowedOrigins(cfg.betterAuth, request),

    session: { expiresIn: SESSION_EXPIRES_IN, updateAge: SESSION_UPDATE_AGE },
    // OWNER DECISION: session rows keep NO network identity. The library fills `ipAddress` and
    // `userAgent` from request headers by default, which would make every signed-in user's raw
    // address a durable database record — the exact thing the analytics design (a keyed,
    // day-scoped hash, never the address) exists to avoid. Stripped here, at the persistence
    // seam, rather than via `advanced.ipAddress.disableIpTracking`: that flag also changes how
    // the library keys its rate limiting, and this decision is about what is STORED, not about
    // what a request transiently is. The columns stay in the schema — no migration; they are
    // simply always empty — so the library's own reads keep their shape.
    databaseHooks: {
      user: {
        create: {
          /** The auth user row is the actual signup event; this runs after its transaction commits. */
          after: async (user) => {
            // Account provisioning and the durable welcome row are best effort. In particular, a
            // provider/database failure here must not turn a successful OTP or OAuth signup into a
            // failed authentication response; legacy identities still provision on first /v1 use.
            await accountService.recordSignupWelcome(user.id);
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({ data: { ...session, ipAddress: "", userAgent: "" } }),
        },
        update: {
          before: async (session) => ({ data: { ...session, ipAddress: "", userAgent: "" } }),
        },
      },
    },

    // WRITTEN OUT RATHER THAN DEFAULTED, because every one of these four is a security decision:
    //   enabled              a second provider on a verified address joins two proofs of one
    //                        mailbox, which is the same proof the first sign-in required.
    //   trustedProviders []  nothing is linked on an UNVERIFIED address. Empty is the strict value.
    //   allowDifferentEmails false — linking across addresses is the code path the library's own
    //                        linking issues are about, and we have no use for it.
    //   updateUserInfoOnLink false — a later provider does not get to rewrite the profile.
    // TRIPWIRE: if `emailAndPassword` is ever added, revisit `disableImplicitLinking` — implicit
    // linking against a password account is a different threat from linking against an OTP one.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
    },

    // Config-ready, shipped dark: with no client id the provider is not registered at all, so the
    // route does not exist and the dashboard renders no button.
    ...(google
      ? {
          socialProviders: {
            google: {
              clientId: cfg.google.clientId as string,
              clientSecret: cfg.google.clientSecret as string,
              // We never call a Google API on the user's behalf, so no offline access and no
              // refresh token to store: the profile arrives in the callback and that is all we want.
              scope: ["openid", "email", "profile"],
            },
          },
        }
      : {}),

    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRES_IN,
        allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        // The database keeps a digest, not the code. A dump of `auth_verification` is then a list
        // of hashes with a five-minute life rather than a list of live sign-in codes.
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          // NOT AWAITED, deliberately: awaiting the provider makes the response time a function of
          // whether the address exists and how the provider felt about it, which is an enumeration
          // oracle. A send that fails is a code that never arrives — the user asks for another.
          void outboundEmail
            .send({
              to: email,
              subject: subjectFor(type),
              text: `Your RFPSear.ch code is ${otp}. It expires in ${OTP_EXPIRES_IN / 60} minutes.\n\nIf you did not ask for it, nothing has happened to your account and you can ignore this message.`,
            })
            .then((result) => {
              if (result.status === "sent") return;
              // NOT SWALLOWED — reported. The response has already gone out (that is the point of
              // not awaiting), so this is the ONLY place a delivery failure can surface: a bad IAM
              // policy, an exhausted quota or a missing key would otherwise stop every sign-in in
              // the deployment while every request kept answering 200, and nothing anywhere would
              // say so.
              //
              // Redacted deliberately. The recipient is fingerprinted rather than written out — a
              // delivery log needs to distinguish "one address keeps failing" from "everything is
              // failing", which a correlatable digest answers and an address only adds PII to — and
              // the code itself never appears, here or anywhere else.
              logger.error(
                {
                  recipient: recipientFingerprint(email),
                  otpType: type,
                  error: result.error,
                  reason: result.reason,
                },
                "sign-in code could not be delivered",
              );
            });
        },
      }),
      bearer({ requireSignature: true }),
      // Minutes, not seconds (the library's unit). Three is its default and is generous for two
      // immediate redirects.
      oneTimeToken({ expiresIn: 3, disableClientRequest: true }),
    ],

    rateLimit: authRateLimit(cfg.betterAuth.rateLimitEnabled),
    // The address is the one the mount resolved, in a header only the mount writes. See
    // `CLIENT_IP_HEADER`. No `trustedProxies`: the header carries exactly one address by
    // construction, and the proxy chain was already walked by Fastify under `TRUST_PROXY`.
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },

    // Explicit, because the package ships a telemetry dependency and "off" should be a decision in
    // this file rather than an environment variable somebody forgets.
    telemetry: { enabled: false },
  });
}

function subjectFor(type: "sign-in" | "email-verification" | "forget-password" | "change-email") {
  switch (type) {
    case "email-verification":
      return "Confirm your RFPSear.ch email address";
    case "change-email":
      return "Confirm your new RFPSear.ch email address";
    default:
      return "Your RFPSear.ch sign-in code";
  }
}

/**
 * The instance type every other module refers to, INFERRED rather than annotated.
 *
 * The alternative — annotating `createAuth` with the library's generic `Auth` — compiles and is
 * worse: the plugin-contributed half of `auth.api` (`sendVerificationOTP`, `signInEmailOTP`,
 * `generateOneTimeToken`) disappears from the type, and every caller of those goes untyped. So the
 * inference is kept, and `zod` is a direct dependency of this package purely so that the inferred
 * type is NAMEABLE: this package emits declarations, its public type surface transitively mentions
 * zod's `v4/core`, and without the direct dependency TypeScript can only reach it through a
 * package-manager-internal path (TS2742).
 */
export type Auth = ReturnType<typeof createAuth>;

/**
 * The deployment's own instance, built once.
 *
 * Lazy because building it constructs the drizzle adapter and reads the config, and an import of
 * this module by a test that injects its own instance should not do either.
 */
let instance: Auth | undefined;
export function defaultAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
