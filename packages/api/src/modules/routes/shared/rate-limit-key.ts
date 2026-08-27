/**
 * Who a request is metered as, and the hook chain that meters it.
 *
 * ── The key ────────────────────────────────────────────────────────────────────────────────────
 * A credentialed route is bucketed per CREDENTIAL-HOLDER, not per address. Two accounts behind one
 * office NAT are two budgets; one account calling from a laptop and from CI is one budget. Keying
 * a write surface by address gets both halves wrong — it punishes the shared egress and it hands a
 * cheap reset to anyone with a second address.
 *
 * The address is the FALLBACK, and only for a request that proved nothing. Nothing here is stored:
 * `req.ip` becomes a key in an in-memory counter that expires with its window, and is never
 * written to a row, a log line or an analytics event.
 *
 * ── The chain ──────────────────────────────────────────────────────────────────────────────────
 * `meteredAuth` exists because the obvious wiring does not work, in two different ways.
 *
 * 1. A GATE ANSWERS, AND ANSWERING ENDS THE CHAIN. `onRequest: requireAuth` plus
 *    `config: { rateLimit }` composes to `[requireAuth, limiter]` — @fastify/rate-limit APPENDS
 *    its handler to whatever the route declared for that hook (`addRouteRateHook`). A request with
 *    a junk Bearer is refused by `requireAuth` and the limiter never runs, so unauthenticated
 *    write traffic was unlimited. The fix is to resolve quietly, meter, and only then gate.
 * 2. TWO LIMITERS DO NOT BOTH RUN. Every handler minted by one registration of the plugin shares a
 *    `rateLimitRan` symbol on the request and returns early once any of them has run — so
 *    `[ipLimiter, requireAuth, accountLimiter]` produces one bucket, not two. There is exactly one
 *    limiter here; which bucket it charges is a decision made by `rateLimitKey`, not by a second
 *    handler.
 *
 * The limiter is built with `router.rateLimit(...)` rather than declared as `config.rateLimit`
 * precisely so its POSITION in the array is ours: the plugin's own registration path can only
 * append. Each call mints an independent store child, so the buckets are per route exactly as the
 * declarative form's were.
 *
 * `config.rateLimit` is still the right form for a route with no credential at all — the two
 * redirects — where there is nothing to resolve and the address is the only key there could be.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";

/** Who this request is being metered as. An account when one is proven; the address otherwise. */
export const rateLimitKey = (req: FastifyRequest): string =>
  req.principal ? `acct:${req.principal.accountId}` : req.ip;

export interface MeteredLimit {
  max: number;
  /** A window in `@fastify/rate-limit` syntax, e.g. `"1 minute"`. */
  timeWindow: string;
}

/**
 * The `onRequest` chain for a credentialed, metered route: resolve → meter → gate.
 *
 * `gate` is whichever refusal the route actually wants (`requireAuth`, `requireSession`,
 * `requireRole("reviewer")`, …). It runs unchanged and answers exactly what it answered before;
 * the only difference is that the request has already been counted by the time it does.
 */
export function meteredAuth(
  router: FastifyInstance,
  gate: onRequestHookHandler,
  limit: MeteredLimit,
): onRequestHookHandler[] {
  return [
    router.auth.resolvePrincipal,
    router.rateLimit({ ...limit, keyGenerator: rateLimitKey }),
    gate,
  ];
}
