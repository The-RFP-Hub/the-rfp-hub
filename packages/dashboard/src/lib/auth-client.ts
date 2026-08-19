"use client";

/*
 * THE ONE PLACE THAT KNOWS HOW A SESSION IS OBTAINED AND WHERE IT IS KEPT.
 *
 * Sessions are **bearer**, not cookies. The API mounts Better-Auth under `/api/auth` on its own
 * origin with the `bearer` plugin, so every authenticated call — the auth calls here and the `/v1`
 * calls in `lib/api.ts` — carries `Authorization: Bearer <token>` and nothing carries a cookie. That
 * is what keeps `credentials: "omit"` true across the whole package and keeps CSRF off the table for
 * `/v1`: a cross-site request to this API has no ambient authority to abuse.
 *
 * WHERE THE TOKEN COMES FROM. Every Better-Auth response that establishes or refreshes a session
 * carries a `set-auth-token` header (the bearer plugin's `after` hook mirrors the session cookie
 * into it, and the API exposes that header through CORS). `onSuccess` below is the single place that
 * reads it. Three different flows produce one — the OTP sign-in, the one-time-token verification
 * that ends the Google handoff, and any later session refresh — and none of them needs its own
 * storage code.
 *
 * WHERE IT IS KEPT, STATED PLAINLY. `localStorage`, which is reachable by any script that executes
 * on this origin. That was true of the previous provider's token too, but the exposure is NOT
 * equivalent and it would be dishonest to imply it is: this token is a **90-day** session rather
 * than an access token of about an hour, so a single successful XSS yields months of access instead
 * of minutes. The compensating controls are real and are named where they live:
 *
 *   - the Content-Security-Policy no longer permits `'unsafe-eval'`, `'wasm-unsafe-eval'` or ANY
 *     third-party origin (`lib/csp.ts`) — the attack surface that would deliver such a script is
 *     materially smaller than it was;
 *   - `test/no-raw-html.test.ts` keeps every HTML-injection API out of `src/`;
 *   - sessions are now revocable server-side, so a compromise is remediable. It was not before.
 *
 * If that trade is ever judged too generous, the fix is a shorter server-side `expiresIn` — not a
 * different store. `sessionStorage` would log a publisher out of every new tab, and a JS-readable
 * cookie is the same exposure with worse ergonomics; an `HttpOnly` cookie is a different
 * architecture (same-site, CSRF tokens, no cross-origin API) and not a storage tweak.
 */
import { emailOTPClient, oneTimeTokenClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { readConfig } from "./config";

/**
 * Namespaced so it cannot collide with anything else parked on this origin — a preview host may
 * serve several apps from one domain, and an unprefixed `token` key is exactly how two of them end
 * up fighting over one slot.
 */
export const SESSION_STORAGE_KEY = "rfphub.session-token";

/**
 * The token for THIS PAGE, held in a module variable as well as in storage.
 *
 * It is not a cache and not an optimisation: it is what makes sign-in work at all when
 * `localStorage` is unavailable. Safari in private mode, a browser with site data blocked and a
 * `SecurityError` on first access all raise rather than degrade, and an earlier version of this file
 * caught that and simply dropped the token — so the very next session read found nothing, and the
 * user was signed out a moment after signing in, with no way to tell why. Keeping it in memory means
 * the session lasts as long as the page does, which is the honest degradation the comment claimed.
 */
let volatileToken: string | null = null;

/**
 * Storage access, wrapped, because `localStorage` throws rather than degrades.
 *
 * Letting that escape would take the render down on a page that had no business needing storage at
 * all — the public directory, for one.
 */
export function readSessionToken(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    /* fall through to the in-memory copy */
  }
  return volatileToken;
}

export function storeSessionToken(token: string): void {
  // Memory FIRST, so a throwing `setItem` cannot lose the token on its way past.
  volatileToken = token;
  try {
    globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* storage unavailable — this session now lasts exactly as long as the page does */
  }
}

export function clearSessionToken(): void {
  volatileToken = null;
  try {
    globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* nothing to clear if nothing could be stored */
  }
}

/**
 * The API's origin, inlined at build time and VALIDATED BY THE SAME FUNCTION THAT DECIDES WHETHER
 * THE APP RENDERS AT ALL.
 *
 * That coupling is the whole point, and it is load-bearing rather than tidy. `createAuthClient`
 * validates its `baseURL` eagerly and THROWS a `BetterAuthError` on anything malformed — verified:
 * `"not a url"` and `"ftp://x"` both throw, while `""` constructs happily. This module is imported
 * by `lib/session.tsx`, which the root layout imports, so a throw here happens during module
 * evaluation: before `AppProviders` can run, before React renders anything, and therefore before the
 * "This dashboard is not configured" screen has a chance to explain what is wrong. Every route would
 * answer 500 with a stack trace, for the one misconfiguration this package works hardest to report
 * legibly.
 *
 * So the value handed over is whatever `readConfig` accepted, and the empty string otherwise. The
 * empty string is safe precisely because it is the one input that does NOT throw, and it is never
 * used: when `readConfig` rejects the variable, `AppProviders` renders the diagnostic instead of the
 * tree, so nothing ever calls this client. The two cannot drift, because there is only one rule.
 */
const configured = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
const apiBaseUrl = configured.ok ? configured.config.apiBaseUrl : "";

export const authClient = createAuthClient({
  // Better-Auth appends its own `basePath` (`/api/auth`), which is where the API mounts it.
  baseURL: apiBaseUrl,
  plugins: [emailOTPClient(), oneTimeTokenClient()],
  fetchOptions: {
    /**
     * NO AMBIENT CREDENTIALS. The library's default is `credentials: "include"`, and that default is
     * wrong for this deployment in two separate ways.
     *
     * It does not work: the API answers `/api/auth/*` with an exact-origin allowlist and
     * `Access-Control-Allow-Credentials` unset, because the session is a bearer token rather than a
     * cookie the browser would attach by itself. A request in credentials mode `include` against a
     * response without that header is rejected by the browser before any application code sees it —
     * every auth call fails as a CORS error and the page hangs at "restoring session…". (Found by
     * the end-to-end suite on its first real browser sign-in.)
     *
     * And it should not work. Asking the browser to attach ambient credentials cross-origin is the
     * property that makes cross-site request forgery possible at all; the whole point of carrying
     * the session in a header is that a cross-site request carries no authority. Setting this
     * explicitly states the architecture rather than inheriting a default that contradicts it.
     */
    credentials: "omit",
    // Bearer in, on every call the auth client makes — including the session read on first paint.
    auth: { type: "Bearer", token: () => readSessionToken() ?? "" },
    // Bearer out. Every session-establishing response carries it; capturing it in one hook is what
    // stops each flow from growing its own copy of this.
    onSuccess: (context) => {
      const token = context.response.headers.get("set-auth-token");
      if (token) storeSessionToken(token);
    },
  },
});

export type AuthClient = typeof authClient;

/**
 * Tell `useSession` to read the session again.
 *
 * WHY THIS HAS TO BE CALLED BY HAND, sometimes. `useSession` is a nanostore fed by a `$sessionSignal`
 * atom, and the client refetches only when that signal flips. Better-Auth flips it for the paths its
 * own listeners name — `/sign-out`, `/sign-in/email` and, via the OTP plugin, `/sign-in/email-otp`
 * [verified in `dist/client/config.mjs`] — which is why the email flow needs nothing extra.
 *
 * Two paths are NOT on that list and each one was a real bug:
 *   - `/one-time-token/verify`, which ends the Google handoff. `oneTimeTokenClient` registers no
 *     atom listener at all, so a successful exchange stored the bearer token and left every mounted
 *     component still believing nobody was signed in — the client-side navigation keeps the provider
 *     mounted, so `/dashboard` asked for a login until a full reload.
 *   - a sign-out whose request FAILED. The listener fires on success; when the API is unreachable
 *     the token is still cleared locally, and without this the tab keeps rendering signed-in
 *     navigation while every request 401s.
 *
 * `$store.notify` is the client's own primitive for this [`dist/client/config.mjs:88-90`]; it flips
 * the atom, which is what the session query subscribes to.
 */
export function refreshSession(): void {
  authClient.$store.notify("$sessionSignal");
}

/**
 * The API's error codes for the OTP step, turned into sentences a person can act on.
 *
 * Better-Auth's own strings ("Invalid OTP") are accurate and useless: they do not say what to do
 * next, and the three failures have three different next steps — retype it, ask for a new one, or
 * wait. The codes are the plugin's published `EMAIL_OTP_ERROR_CODES`.
 */
/**
 * A call that never reached the API at all.
 *
 * THE CLIENT REJECTS RATHER THAN RETURNING `{ error }` FOR TRANSPORT FAILURES, and that asymmetry is
 * the trap this exists for. A 400 or a 404 resolves with an `error` member, so `const { error } =
 * await …` reads as if it covered everything; a dropped connection, a DNS failure or a CORS refusal
 * REJECTS — verified against all four actions this package calls. Every caller therefore needs a
 * `catch`, and every `catch` needs the same sentence, which is here rather than in three places.
 *
 * The distinction matters to the reader too: "we could not reach the service" is a different
 * instruction from "that code was wrong". Only one of them is worth retrying unchanged.
 */
export function describeTransportFailure(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() ? ` (${cause.message})` : "";
  return `The sign-in service could not be reached${detail}. Check your connection and try again.`;
}

export function describeOtpFailure(code: string | undefined, fallback: string): string {
  if (code === "INVALID_OTP") return "That code is not right. Check it and try again.";
  if (code === "OTP_EXPIRED") return "That code has expired. Ask for a new one.";
  if (code === "TOO_MANY_ATTEMPTS") {
    return "Too many attempts on that code. Ask for a new one to start again.";
  }
  return fallback;
}
