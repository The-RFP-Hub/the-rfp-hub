import { BlockList, isIP } from "node:net";

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isNonPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(mapped);
  if (family === 0) return false;
  return NON_PUBLIC.check(mapped, family === 4 ? "ipv4" : "ipv6");
}

type FastifyTrustProxy = string[] | ((address: string, hop: number) => boolean) | undefined;

/**
 * Fastify 5.12.2+ no longer accepts a bare hop count: it cannot tell whether the immediate peer is
 * a proxy at all, so a client connecting directly could supply enough `X-Forwarded-For` entries to
 * choose its own address. A count is kept as the configuration, and the peer is checked here: the
 * socket address must be private or loopback, which is what a load balancer inside the network is.
 * Hops past the first are only reached once the peer has been trusted, so the count still bounds
 * how many entries are believed.
 */
export function buildTrustProxy(configured: number | string[] | undefined): FastifyTrustProxy {
  if (typeof configured !== "number") return configured;
  return (address, hop) => (hop === 0 ? isNonPublicAddress(address) : hop < configured);
}
