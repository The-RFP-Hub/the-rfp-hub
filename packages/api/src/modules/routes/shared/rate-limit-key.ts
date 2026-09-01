/**
 * Who a request is metered as, and the hook chain that meters it.
 *
 * A credentialed route is bucketed per CREDENTIAL-HOLDER: two accounts behind one office NAT are
 * two budgets, and one account calling from a laptop and from CI is one budget. The address is the
 * fallback, for a request that proved nothing. Nothing here is stored — the key lives in an
 * in-memory counter that expires with its window.
 */
import { isIPv4, isIPv6 } from "node:net";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";

const IPV6_SUBNET_BITS = 64;
const IPV6_GROUPS = IPV6_SUBNET_BITS / 16;

/**
 * The two namespaces are DISJOINT, and that is a security property rather than tidiness. Behind a
 * trusted proxy `request.ip` is whichever `X-Forwarded-For` token the hop count selected, so a
 * caller who can reach that proxy can put arbitrary text there — `acct:1` included. Sharing one
 * namespace would let that text land in an account's bucket.
 */
const ACCOUNT_PREFIX = "acct:";
const ADDRESS_PREFIX = "ip:";
/** Where every unparseable address goes. One fixed bucket, never the caller's own text as a key. */
const INVALID_ADDRESS = `${ADDRESS_PREFIX}invalid`;

/**
 * The eight 16-bit groups of an IPv6 address, or null if it does not parse.
 *
 * Written out rather than delegated: the library that would do it (`ip-address`) is
 * @fastify/rate-limit's dependency, not ours, and reaching into it is a phantom import pnpm's
 * layout exists to refuse.
 */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
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
 * The host part of an address that may carry brackets, a port or a scope id.
 *
 * A port must never reach the key: one bucket per source port is one fresh bucket per connection.
 * The IPv4 port form is matched as a whole so a value like `acct:7` — one colon, digits after it —
 * is not mistaken for a host and a port.
 */
function hostOf(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(trimmed);
  const host =
    bracketed?.[1] ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(trimmed)?.[1] ?? trimmed;
  // A scope id (`fe80::1%eth0`) names an interface on THIS host, never a caller identity.
  return host.split("%")[0] ?? "";
}

/**
 * The address, grouped into the smallest unit a caller cannot trivially move within.
 *
 * AN IPv6 HOST ADDRESS IS NOT AN IDENTITY. The smallest allocation a residential or cloud IPv6
 * customer receives is a /64, and all 2^64 addresses in it are theirs — so a limiter keyed on the
 * full address hands out a fresh, empty bucket on every request. `@fastify/rate-limit`'s own
 * default generator groups by /64 for this reason, and supplying a custom `keyGenerator` replaces
 * that generator wholesale, so the grouping has to be carried over with it. IPv4 is left alone.
 *
 * The two IPv6 forms that EMBED an IPv4 address are folded back to it: the mapped `::ffff:a.b.c.d`
 * a dual-stack listener reports for a v4 client, and the deprecated compatible `::a.b.c.d`. Both
 * have zeros where the /64 lives, so without the fold every such caller would share one bucket.
 */
export function addressBucket(address: string): string {
  const host = hostOf(address);
  if (isIPv4(host)) return ADDRESS_PREFIX + host;
  if (!isIPv6(host)) return INVALID_ADDRESS;
  const groups = ipv6Groups(host);
  if (groups === null) return INVALID_ADDRESS;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, marker = 0, hi = 0, lo = 0] = groups;
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  // `marker === 0` is the compatible form, and only a written dotted quad distinguishes it from
  // `::1` or `::` — which are not callers and may share a bucket.
  if (zeroPrefix && (marker === 0xffff || (marker === 0 && host.includes(".")))) {
    return `${ADDRESS_PREFIX}${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${ADDRESS_PREFIX}${groups
    .slice(0, IPV6_GROUPS)
    .map((group) => group.toString(16))
    .join(":")}::/${IPV6_SUBNET_BITS}`;
}

/** Who this request is being metered as. An account when one is proven; the address otherwise. */
export const rateLimitKey = (req: FastifyRequest): string =>
  req.principal ? `${ACCOUNT_PREFIX}${req.principal.accountId}` : addressBucket(req.ip);

export interface MeteredLimit {
  max: number;
  /** A window in `@fastify/rate-limit` syntax, e.g. `"1 minute"`. */
  timeWindow: string;
}

/**
 * The `onRequest` chain for a credentialed, metered route: resolve → meter → gate.
 *
 * The obvious wiring does not work, in two ways. A GATE ANSWERS, AND ANSWERING ENDS THE CHAIN:
 * `onRequest: requireAuth` plus `config: { rateLimit }` composes to `[requireAuth, limiter]`,
 * because the plugin APPENDS its handler to whatever the route declared — so a junk Bearer was
 * refused before the limiter ever ran and unauthenticated write traffic was unlimited. And TWO
 * LIMITERS DO NOT BOTH RUN: every handler minted by one registration shares a `rateLimitRan`
 * symbol and returns early once any of them has run, so `[ipLimiter, gate, accountLimiter]` is one
 * bucket, not two. There is exactly one limiter here; which bucket it charges is `rateLimitKey`'s
 * decision. `router.rateLimit(...)` rather than `config.rateLimit` is what puts its POSITION in
 * this array under our control.
 *
 * `config.rateLimit` remains right for a route with no credential at all — the two redirects.
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
