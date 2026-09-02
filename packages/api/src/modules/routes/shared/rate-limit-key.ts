/** Who a request is metered as, and the chain that meters it. See `docs/auth.md` §Rate limits. */
import { isIPv4, isIPv6 } from "node:net";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { HttpError } from "../../shared/http-error.js";

const IPV6_SUBNET_BITS = 64;
const IPV6_GROUPS = IPV6_SUBNET_BITS / 16;

/** DISJOINT: behind a trusted proxy `request.ip` is attacker-written text, `acct:1` included. */
const ACCOUNT_PREFIX = "acct:";
const ADDRESS_PREFIX = "ip:";
const INVALID_ADDRESS = `${ADDRESS_PREFIX}invalid`;

/** What a throttled caller branches on: the default body is the generic `client_error`, which an
 * integrator cannot tell from a validation failure. */
export const RATE_LIMITED_CODE = "rate_limited";

/** The 429 body for EVERY limiter — set once on the registration, so the metered writes, the two
 * redirects and the auth mount cannot drift apart. `ttl` is ms, and `Retry-After` is its ceiling. */
export const rateLimitedError = (_request: FastifyRequest, context: { ttl: number }): HttpError =>
  new HttpError(
    429,
    RATE_LIMITED_CODE,
    `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)} seconds`,
  );

/** What the limiter emits, and what BOTH CORS policies must expose or a browser cannot read it. */
export const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/** The eight 16-bit groups, or null. Hand-rolled: `ip-address` is not our dependency. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    const out: number[] = [];
    for (const token of part.split(":")) {
      if (token === "") continue;
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

/** The IPv4 port form is matched whole, so `acct:7` is not mistaken for a host and a port. */
function hostOf(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(trimmed);
  const host =
    bracketed?.[1] ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(trimmed)?.[1] ?? trimmed;
  return host.split("%")[0] ?? "";
}

/**
 * AN IPv6 HOST ADDRESS IS NOT AN IDENTITY: a customer holds a whole /64, so a key on the full
 * address is a fresh bucket per request. @fastify/rate-limit groups by /64 for this reason and a
 * custom `keyGenerator` replaces its generator wholesale, so the grouping is carried over here.
 * The two forms embedding an IPv4 address fold back to it, or every v4 client of a dual-stack
 * listener shares the one bucket their zero /64 gives them.
 */
export function addressBucket(address: string): string {
  const host = hostOf(address);
  if (isIPv4(host)) return ADDRESS_PREFIX + host;
  if (!isIPv6(host)) return INVALID_ADDRESS;
  const groups = ipv6Groups(host);
  if (groups === null) return INVALID_ADDRESS;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, marker = 0, hi = 0, lo = 0] = groups;
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  if (zeroPrefix && (marker === 0xffff || (marker === 0 && host.includes(".")))) {
    return `${ADDRESS_PREFIX}${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${ADDRESS_PREFIX}${groups
    .slice(0, IPV6_GROUPS)
    .map((group) => group.toString(16))
    .join(":")}::/${IPV6_SUBNET_BITS}`;
}

export const rateLimitKey = (req: FastifyRequest): string =>
  req.principal ? `${ACCOUNT_PREFIX}${req.principal.accountId}` : addressBucket(req.ip);

export interface MeteredLimit {
  max: number;
  timeWindow: string;
}

/**
 * resolve → meter → gate. `config.rateLimit` is APPENDED after the route's own hooks, so a gate
 * answered first and the limiter never ran for a junk Bearer; `router.rateLimit(...)` puts its
 * POSITION under our control. TWO LIMITERS DO NOT BOTH RUN — handlers from one registration share
 * a `rateLimitRan` symbol — so there is exactly one, and `rateLimitKey` picks its bucket.
 */
export function meteredAuth(
  router: FastifyInstance,
  gate: onRequestHookHandler,
  limit: MeteredLimit,
): onRequestHookHandler[] {
  const meter = router.rateLimit({
    ...limit,
    keyGenerator: rateLimitKey,
    allowList: authUnavailable,
  });
  // Named — route-inventory.test.ts reads hook names; `call` because `this` is the minting instance.
  const rateLimiter: onRequestHookHandler = async (request, reply) => {
    await meter.call(router, request, reply);
  };
  return [router.auth.resolvePrincipal, rateLimiter, gate];
}

/**
 * Skip the increment when the credential could not be CHECKED: that 5xx is ours, and metering it
 * would spend the caller's budget on our outage and then replace the 503 an operator watches for
 * with a 429. The gate behind the limiter still emits it.
 */
const authUnavailable = (request: FastifyRequest): boolean =>
  request.principalResolution?.kind === "unavailable";
