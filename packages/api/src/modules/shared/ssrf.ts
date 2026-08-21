/**
 * PURE address and scheme classification for the outbound verifier — no DNS, no sockets, no I/O.
 *
 * The verifier fetches a URL a stranger submitted. Everything the process can reach from inside
 * the network is therefore in scope: another service on the same subnet, a database bound to a
 * private address, and above all `169.254.169.254`, the link-local instance metadata endpoint,
 * whose response is credentials.
 *
 * This module answers one question — "is this address one we are willing to connect to?" — and
 * answers it about a RESOLVED ADDRESS, never about a hostname. That distinction is the design:
 *
 *   Checking the hostname, or resolving it once to check and then handing the name to `fetch`,
 *   resolves TWICE. An attacker controlling the authoritative DNS answers with a public address
 *   for the check and a link-local one for the connection — the classic rebinding TOCTOU, and no
 *   amount of re-validating redirect targets closes it, because the gap is between the check and
 *   the socket, not between hops.
 *
 *   The caller therefore resolves ONCE, validates the resulting address here, and then connects
 *   through a dispatcher pinned to that exact address (with TLS `servername` still set from the
 *   hostname, so certificate validation continues to target the real name). This module is the
 *   validation half; the pinning half is the fetcher's.
 *
 * An ALLOWLIST of address space would be the stronger shape, but there is no allowlist of "the
 * public internet" to write. So this is a denylist, and it is exhaustive by construction: every
 * IANA special-purpose range, not merely the famous three private ones. A network-layer egress
 * control (`VERIFIER_EGRESS_PROXY`, security groups) remains the backstop this check should not be
 * alone in providing.
 */
import { isIP } from "node:net";

/** The only schemes the verifier will follow. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Whether a URL scheme may be fetched.
 *
 * Everything else is refused by name rather than by omission, because the interesting ones are not
 * network protocols at all: `file:` reads the container's filesystem, `gopher:`/`dict:` are the
 * classic protocol-smuggling primitives, and `data:` would let a submitter's "source page" be
 * whatever they typed.
 */
export function isAllowedScheme(protocol: string): boolean {
  return ALLOWED_SCHEMES.has(protocol.toLowerCase());
}

export interface AddressVerdict {
  allowed: boolean;
  /** The range that matched, for the failed verification run's record. */
  category: string;
  /** Present when refused: a sentence naming what was matched. */
  reason?: string;
}

const ok = (category: string): AddressVerdict => ({ allowed: true, category });
const deny = (category: string, reason: string): AddressVerdict => ({
  allowed: false,
  category,
  reason,
});

/** The four octets of an IPv4 address. A tuple, so every index below is a number. */
type Quad = [number, number, number, number];

/** Dotted-quad → four octets, or undefined. `isIP` has already established the shape. */
function octets(address: string): Quad | undefined {
  const [a, b, c, d, ...rest] = address.split(".").map((p) => Number(p));
  if (rest.length > 0) return undefined;
  const quad = [a, b, c, d];
  if (!quad.every((n) => n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255)) {
    return undefined;
  }
  return quad as Quad;
}

/** Every IANA special-purpose IPv4 range. Ordered narrowest-first where ranges nest. */
function classifyIPv4(address: string): AddressVerdict {
  const o = octets(address);
  if (!o) return deny("unparseable", `${address} is not a usable IPv4 address`);
  const [a, b] = o;

  if (a === 0) return deny("unspecified", `${address} is in 0.0.0.0/8 ("this network")`);
  if (a === 10) return deny("private", `${address} is in the private range 10.0.0.0/8`);
  if (a === 100 && b >= 64 && b <= 127) {
    return deny("cgnat", `${address} is in the carrier-grade NAT range 100.64.0.0/10`);
  }
  if (a === 127) return deny("loopback", `${address} is loopback (127.0.0.0/8)`);
  // The one that matters most: the cloud instance metadata endpoint lives at 169.254.169.254, and
  // it answers unauthenticated requests with credentials.
  if (a === 169 && b === 254) {
    return deny("link-local", `${address} is link-local (169.254.0.0/16 — the metadata endpoint)`);
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return deny("private", `${address} is in the private range 172.16.0.0/12`);
  }
  if (a === 192 && b === 0 && o[2] === 0) {
    return deny("reserved", `${address} is in the IETF protocol assignment range 192.0.0.0/24`);
  }
  if (a === 192 && b === 168) {
    return deny("private", `${address} is in the private range 192.168.0.0/16`);
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return deny("benchmark", `${address} is in the benchmarking range 198.18.0.0/15`);
  }
  // Documentation ranges are not routable, so reaching one means something is misconfigured.
  if (
    (a === 192 && b === 0 && o[2] === 2) ||
    (a === 198 && b === 51 && o[2] === 100) ||
    (a === 203 && b === 0 && o[2] === 113)
  ) {
    return deny("documentation", `${address} is in a documentation range (RFC 5737)`);
  }
  if (a >= 224 && a <= 239) return deny("multicast", `${address} is multicast (224.0.0.0/4)`);
  if (a >= 240) return deny("reserved", `${address} is in the reserved range 240.0.0.0/4`);
  return ok("public");
}

/** Expand an IPv6 literal to eight 16-bit groups. `isIP` has established the shape. */
function groups(address: string): number[] | undefined {
  // The zone id (`fe80::1%eth0`) names an interface, not part of the address.
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const halves = bare.split("::");
  if (halves.length > 2 || halves[0] === undefined) return undefined;

  // A trailing dotted-quad (`::ffff:127.0.0.1`) is two groups, written the other way round.
  const expand = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const [a, b, c, d] = octets(piece) ?? [];
        if (a === undefined || b === undefined || c === undefined || d === undefined) {
          return undefined;
        }
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function classifyIPv6(address: string): AddressVerdict {
  const parsed = groups(address);
  if (!parsed || parsed.length !== 8) {
    return deny("unparseable", `${address} is not a usable IPv6 address`);
  }
  const g = (i: number): number => parsed[i] ?? 0;

  // An IPv4-mapped or NAT64-translated address is an IPv4 destination wearing an IPv6 literal.
  // Classifying it as "some IPv6 address" is exactly how `::ffff:169.254.169.254` reaches the
  // metadata endpoint through a check that only knew about dotted quads.
  const asV4 = (): string => `${g(6) >> 8}.${g(6) & 255}.${g(7) >> 8}.${g(7) & 255}`;
  if (parsed.slice(0, 5).every((x) => x === 0) && g(5) === 0xffff) {
    const inner = classifyIPv4(asV4());
    return inner.allowed
      ? ok(`ipv4-mapped:${inner.category}`)
      : deny(`ipv4-mapped:${inner.category}`, `${address} maps to IPv4: ${inner.reason}`);
  }
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    const inner = classifyIPv4(asV4());
    return inner.allowed
      ? ok(`nat64:${inner.category}`)
      : deny(`nat64:${inner.category}`, `${address} translates to IPv4: ${inner.reason}`);
  }

  if (parsed.every((x) => x === 0)) {
    return deny("unspecified", `${address} is the unspecified address ::`);
  }
  if (parsed.slice(0, 7).every((x) => x === 0) && g(7) === 1) {
    return deny("loopback", `${address} is IPv6 loopback (::1)`);
  }
  if (g(0) === 0x0100 && parsed.slice(1, 4).every((x) => x === 0)) {
    return deny("discard", `${address} is in the discard-only range 100::/64`);
  }
  if (g(0) === 0x2001 && g(1) === 0x0db8) {
    return deny("documentation", `${address} is in the documentation range 2001:db8::/32`);
  }
  if ((g(0) & 0xfe00) === 0xfc00) {
    return deny("private", `${address} is a unique local address (fc00::/7)`);
  }
  if ((g(0) & 0xffc0) === 0xfe80) {
    return deny("link-local", `${address} is IPv6 link-local (fe80::/10)`);
  }
  if ((g(0) & 0xff00) === 0xff00) {
    return deny("multicast", `${address} is IPv6 multicast (ff00::/8)`);
  }
  return ok("public");
}

/**
 * Whether a RESOLVED address may be connected to.
 *
 * Takes an address, never a hostname — passing a name here would be the rebinding bug this module
 * exists to prevent, so a non-address input is refused rather than resolved.
 */
export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return classifyIPv4(address);
  if (family === 6) return classifyIPv6(address.replace(/^\[|\]$/g, ""));
  return deny(
    "not-an-address",
    `${JSON.stringify(address)} is not an IP address. This check must run on a RESOLVED address: validating a hostname and then letting the connection resolve it again is the DNS-rebinding gap.`,
  );
}

/** Convenience for the common call: allowed, or not. */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address).allowed;
}
