/**
 * Where the session authority is exposed over HTTP — and the walls around it.
 *
 * ENCAPSULATED, unlike `plugins/auth.ts`. That one decorates the ROOT instance because every route
 * module must see its gates; this one must be the opposite, because everything it registers is
 * hostile to the rest of the API:
 *
 *   - a `"*"` content-type parser that hands the handler RAW BYTES. `/v1` wants parsed JSON and its
 *     own validation; the auth library wants the body exactly as it arrived, because it computes
 *     over it. Fastify's encapsulation is what keeps one from becoming the other.
 *   - a SECOND CORS POLICY, exported from here and selected per request by the single `@fastify/cors`
 *     registration in `app.ts` (`authCorsOptions`). `/v1` is `origin:"*"` because every `/v1`
 *     credential is header-borne, so a cross-site request carries no ambient authority. These
 *     routes are not that: they MINT the credential, and they expose `set-auth-token` so a browser
 *     can read it. `origin:"*"` plus that exposed header would make any page on the web a working
 *     login client for this deployment — no cryptographic bypass, since a code still has to arrive
 *     in somebody's mailbox, but a phishing surface and a least-privilege violation for nothing.
 *     So: exact origins only.
 *
 *     ONE REGISTRATION, TWO POLICIES, and not by preference: `@fastify/cors` decorates the request
 *     object unconditionally, so registering it a second time — even inside an encapsulated scope —
 *     throws `FST_ERR_DEC_ALREADY_PRESENT`. Its `delegator` seam is the supported way to vary the
 *     policy per request, and it has the better property anyway: both policies are chosen in one
 *     visible place instead of depending on which registration's hook ran first.
 *
 * THE OFFICIAL GUIDE'S `JSON.stringify(request.body)` IS DELIBERATELY NOT USED. Re-serialising a
 * parsed body changes the bytes — key order, number formatting, unicode escapes — and silently
 * corrupts anything that is not JSON at all. The parser below is byte-exact.
 *
 * `/api/auth`, NOT `/v1`. `/v1` is the published, versioned, OpenAPI-documented contract; a
 * vendor's route shapes must not enter it and must not appear in its document (`hide: true`, pinned
 * by `openapi.test.ts`).
 */
import type { FastifyCorsOptions } from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "../auth/better-auth.js";
import { type AuthConfig, isAllowedOrigin } from "../auth/better-auth.js";
import { deliversEmail } from "../auth/email-transport.js";
import { HttpError, badRequest, unauthorized } from "../modules/shared/http-error.js";

export interface BetterAuthPluginOptions {
  auth: Auth;
  config: AuthConfig;
}

/** The prefix the auth routes live under — and the one the narrow CORS policy applies to. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The auth routes whose PURPOSE is to put a code in somebody's mailbox.
 *
 * Enumerated rather than pattern-matched, and enumerated from the library's own route table
 * (`dist/plugins/email-otp/routes.mjs`): these four call `sendVerificationOTP`, and the four that
 * only VERIFY a code — `check-verification-otp`, `verify-email`, `reset-password` and
 * `sign-in/email-otp` — deliberately are not here. Blocking those would change what an attacker
 * learns from submitting a code, which is the opposite of the point.
 */
const EMAIL_SENDING_PATHS: ReadonlySet<string> = new Set([
  `${AUTH_BASE_PATH}/email-otp/send-verification-otp`,
  `${AUTH_BASE_PATH}/email-otp/request-password-reset`,
  `${AUTH_BASE_PATH}/forget-password/email-otp`,
  `${AUTH_BASE_PATH}/email-otp/request-email-change`,
]);

/**
 * The narrow policy, for `/api/auth/*` and the handoff. See the header for why it is not `*`.
 */
export function authCorsOptions(config: AuthConfig): FastifyCorsOptions {
  return {
    origin: (origin, callback) => {
      // A request with no `Origin` is not a cross-site request — same-origin navigations, server to
      // server, curl. Nothing is granted by answering false, and nothing is exposed by it either.
      callback(null, isAllowedOrigin(config.betterAuth, origin ?? undefined));
    },
    // True, and ONLY here — never on `/v1`. The session stays a bearer token, but the OAuth hop
    // cannot work without one cookie: `sign-in/social` answers with the state nonce in a
    // `Set-Cookie`, and a browser in credentials-mode `omit` DISCARDS that header, so every Google
    // callback died on `state_mismatch`. Allowing credentials on these routes lets the one fetch
    // that starts the hop (and only it — the client stays `omit` everywhere else) store the state
    // cookie the callback navigation then presents. The cookie is a ten-minute nonce, not a
    // session: it grants nothing by being attached, and only origins this callback already
    // trusts ever receive this answer.
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // The whole point of the split policy: this is the header the client reads its session out of.
    exposedHeaders: ["set-auth-token"],
    maxAge: 600,
  };
}

/**
 * TWO BUCKETS, because the two kinds of traffic here are nothing alike.
 *
 * Sending mail is expensive, abusable and rare: a person asks for a code, maybe twice. Everything
 * else on this surface is routine and bursty — a dashboard restores its session on every tab it is
 * opened in, an OAuth callback lands, a sign-out fires. One shared bucket meant the routine traffic
 * spent the mail budget: several tabs behind one NAT address, and session restoration starts
 * answering 429 to people who are simply signed in.
 *
 * A per-route `config.rateLimit` is a per-route bucket, so the split is two registrations of the
 * same handler rather than one clever key function.
 */
const MAIL_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const SESSION_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** The path alone — a query string must not decide whether a route is guarded. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** The Fastify request, as the Web `Request` the auth handler consumes. */
function toWebRequest(request: FastifyRequest, baseUrl: string): Request {
  const url = new URL(request.url, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers,
    // The raw bytes the parser preserved. `Buffer` is a `Uint8Array`, which `BodyInit` accepts.
    ...(hasBody && request.body instanceof Buffer ? { body: request.body } : {}),
  });
}

/** The Web `Response`, written back through Fastify without touching the bytes. */
async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  // `set-cookie` is the one header that legitimately repeats, and merging it into a comma-joined
  // string breaks it. `getSetCookie()` is the only API that keeps them separate.
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
  });
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  reply.code(response.status);
  const body = Buffer.from(await response.arrayBuffer());
  return reply.send(body);
}

/**
 * Where an OAuth callback is allowed to send the browser next.
 *
 * THE ONLY ROUTE IN THIS API THAT TAKES A REDIRECT TARGET, so it is the only one that can be an
 * open redirect. A supplied `returnTo` is parsed, required to be a real origin we already trust for
 * sign-in, and reduced to that ORIGIN — the caller does not get to choose the path either. Absent,
 * it falls back to the first configured origin rather than to anything derived from the request.
 */
export function resolveHandoffOrigin(config: AuthConfig, returnTo: string | undefined): string {
  if (returnTo === undefined || returnTo.trim() === "") {
    const fallback = config.betterAuth.trustedOrigins[0];
    if (fallback === undefined) {
      throw badRequest(
        "handoff_unconfigured",
        "this deployment has no TRUSTED_ORIGINS, so there is nowhere to hand a session off to.",
      );
    }
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    throw badRequest("invalid_return_to", "`returnTo` must be an absolute URL.");
  }
  if (!isAllowedOrigin(config.betterAuth, parsed.origin)) {
    // Deliberately does not echo the rejected origin back: the answer is the same for every origin
    // that is not on the list, and repeating it invites using this endpoint as a reflector.
    throw badRequest(
      "invalid_return_to",
      "`returnTo` is not an origin this deployment signs into.",
    );
  }
  return parsed.origin;
}

export async function registerBetterAuth(
  app: FastifyInstance,
  options: BetterAuthPluginOptions,
): Promise<void> {
  const { auth, config } = options;

  // Byte-exact, and scoped to this plugin by encapsulation — `/v1` keeps Fastify's JSON parsing and
  // its own validators.
  //
  // THE REMOVAL IS NOT OPTIONAL. A `"*"` parser is the fallback Fastify reaches for when no SPECIFIC
  // one matches, and the root instance's built-in `application/json` parser is inherited by this
  // scope — so without this line every JSON request (which is all of them) would arrive parsed, the
  // handler would be handed an object where it expects bytes, and it would answer "expected object,
  // received undefined" on a body that was right there. Removing them here affects this scope only.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  const delegate = async (request: FastifyRequest, reply: FastifyReply) => {
    // A DOOR THAT ANSWERS "YES" AND OPENS ONTO NOTHING is worse than a locked one, and this is
    // the only place it can be caught. The library does not await the send — deliberately, so
    // that response times do not reveal whether an address exists — so a transport that discards
    // the message cannot make itself heard from inside: the request has already answered 200 and
    // the caller is waiting for a code that was never going to arrive.
    //
    // So the refusal happens BEFORE delegating, and it says the true thing: this deployment
    // cannot deliver. 503 rather than 4xx because nothing about the request is wrong.
    if (!deliversEmail(config.email) && EMAIL_SENDING_PATHS.has(pathOf(request.url))) {
      throw new HttpError(
        503,
        "auth_unconfigured",
        "email delivery is not configured, so no sign-in code can be sent.",
      );
    }
    const response = await auth.handler(toWebRequest(request, config.betterAuth.url));
    return sendWebResponse(reply, response);
  };

  // The four that put a code in a mailbox, registered by name so they get their own, tighter
  // bucket. An exact path beats the wildcard below, so these are what Fastify matches first.
  for (const url of EMAIL_SENDING_PATHS) {
    app.route({
      method: "POST",
      url,
      // Out of the published document. These are the auth library's route shapes, not our contract.
      schema: { hide: true },
      config: { rateLimit: MAIL_RATE_LIMIT },
      handler: delegate,
    });
  }

  // Everything else on the surface: sign-in with a code, session reads, callbacks, sign-out.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    config: { rateLimit: SESSION_RATE_LIMIT },
    handler: delegate,
  });

  /**
   * The OAuth → bearer hop.
   *
   * Google's callback lands a host-only `HttpOnly` cookie on THIS origin, which the dashboard —
   * a different origin — cannot read. So this route, which the cookie IS sent to, exchanges it for
   * a one-time token and redirects to the dashboard carrying it in the FRAGMENT: fragments are not
   * sent to servers and do not appear in access logs or `Referer`.
   *
   * That is a narrowing, not a guarantee: a fragment still reaches session restore, history,
   * same-origin scripts and extensions. The token is therefore single-use with a three-minute life,
   * and the page that receives it scrubs the URL before its first `await`. `disableClientRequest`
   * on the plugin means nothing but this route can mint one.
   */
  app.get(
    "/api/auth-handoff",
    // The session bucket: this is one hop of a sign-in a person is already in the middle of, not a
    // mail-producing route, and rate-limiting it as one would strand them at the last step.
    { schema: { hide: true }, config: { rateLimit: SESSION_RATE_LIMIT } },
    async (request, reply) => {
      const { returnTo } = request.query as { returnTo?: string };
      const origin = resolveHandoffOrigin(config, returnTo);
      const headers = new Headers();
      const cookie = request.headers.cookie;
      if (cookie !== undefined) headers.set("cookie", cookie);

      const minted = await auth.api.generateOneTimeToken({ headers }).catch(() => null);
      const token = minted?.token;
      // No session on the cookie means the callback did not happen, or happened to somebody else.
      if (typeof token !== "string" || token === "") {
        throw unauthorized("no session to hand off.");
      }
      return reply.redirect(`${origin}/auth/complete#ott=${encodeURIComponent(token)}`, 302);
    },
  );
}
