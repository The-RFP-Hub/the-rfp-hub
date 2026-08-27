/**
 * Who a request is metered as, and the hook chain that meters it.
 *
 * ── The key ────────────────────────────────────────────────────────────────────────────────────
 * A credentialed route is bucketed per CREDENTIAL-HOLDER, not per address. Two accounts behind one
 * office NAT are two budgets; one account calling from a laptop and from CI is one budget. Keying
 * a write surface by address gets both halves wrong — it punishes the shared egress and it hands a
 * cheap reset to anyone with a second address.
 *
 * The address is the FALLBACK, and only for a request that proved nothing. It is GROUPED BEFORE IT
 * IS USED — see `addressBucket` — because a raw IPv6 address is not a caller, it is one of the
 * 18 quintillion a caller was handed. Nothing here is stored: the grouped address becomes a key in
 * an in-memory counter that expires with its window, and is never written to a row, a log line or
 * an analytics event.
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
import { isIPv4, isIPv6 } from "node:net";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";

/** What @fastify/rate-limit's own default generator groups an IPv6 caller by. Match it. */
const IPV6_SUBNET_BITS = 64;
const IPV6_GROUPS = IPV6_SUBNET_BITS / 16;

/**
 * The eight 16-bit groups of an IPv6 address, or null if it does not parse.
 *
 * Written out rather than delegated because the library that would do it (`ip-address`) is
 * @fastify/rate-limit's dependency, not ours — reaching into it would be a phantom import that
 * pnpm's layout is specifically built to refuse, and vendoring a whole address library to truncate
 * four groups is worse than truncating four groups.
 */
function ipv6Groups(address: string): number[] | null {
  // A scope id (`fe80::1%eth0`) names an interface on THIS host, never a caller identity.
  const bare = address.split("%")[0] ?? "";
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    const out: number[] = [];
    for (const token of part.split(":")) {
      if (token === "") continue;
      // A trailing dotted quad (`::ffff:203.0.113.9`) is two groups, not one.
      if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        const [a = 0, b = 0, c = 0, d = 0] = octets;
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      const group = Number.parseInt(token, 16);
      if (!/^[0-9a-f]{1,4}$/i.test(token) || Number.isNaN(group)) return null;
      out.push(group);
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/**
 * The address, grouped into the smallest unit a caller cannot trivially move within.
 *
 * AN IPv6 HOST ADDRESS IS NOT AN IDENTITY. The smallest thing a residential or cloud IPv6 customer
 * is assigned is a /64, and every one of the 2^64 addresses inside it is theirs to use — so a
 * limiter keyed on the full address hands an attacker a fresh, empty bucket on every single
 * request by incrementing the host bits. `@fastify/rate-limit`'s own default generator groups by
 * /64 for exactly this reason (`normalizeIP`, `defaultIPv6Subnet = 64`); supplying a custom
 * `keyGenerator` replaces that generator wholesale, so the grouping has to be carried over with it
 * or it is silently lost. IPv4 is left alone: a v4 address is not handed out 2^64 at a time.
 *
 * An IPv4-mapped address (`::ffff:203.0.113.9`) is folded to the IPv4 address it carries — without
 * that step its first four groups are all zero and EVERY mapped caller would share one bucket,
 * which is the opposite failure and a worse one.
 */
export function addressBucket(address: string): string {
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return address.toLowerCase();
  const groups = ipv6Groups(address);
  if (groups === null) return address.toLowerCase();
  const [a = 0, b = 0, c = 0, d = 0, e = 0, marker = 0, hi = 0, lo = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && marker === 0xffff) {
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups
    .slice(0, IPV6_GROUPS)
    .map((group) => group.toString(16))
    .join(":")}::/${IPV6_SUBNET_BITS}`;
}

/** Who this request is being metered as. An account when one is proven; the address otherwise. */
export const rateLimitKey = (req: FastifyRequest): string =>
  req.principal ? `acct:${req.principal.accountId}` : addressBucket(req.ip);

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
