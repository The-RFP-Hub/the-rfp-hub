/**
 * "Is this host reachable without leaving the machine?" — the one question two different
 * transport-security rules in this package both have to answer.
 *
 * It lives in its own module rather than in `src/config.ts` because the second caller is an
 * offline task with NO database: importing `config.ts` for a predicate would evaluate the server's
 * whole configuration and print its `DATABASE_URL` fallback notice on a run that never opens a
 * connection. A rule shared by two callers is worth exactly one implementation, and this is it.
 */

/**
 * Hosts whose traffic never leaves the machine — the only ones allowed to speak plaintext, because
 * there is no network segment on which that plaintext could be observed or tampered with. The set
 * is deliberately narrow, and deliberately says nothing about any particular domain:
 *
 * - `localhost` and any `*.localhost` name: RFC 6761 §6.3 reserves the whole subtree to resolve to
 *   loopback, so `http://api.localhost:3001` is a legitimate development origin;
 * - the entire IPv4 loopback block `127.0.0.0/8` (RFC 1122 §3.2.1.3), not merely `127.0.0.1` —
 *   every address in it is loopback, and per-service aliases like `127.0.0.2` are a common habit;
 * - `::1`, the IPv6 loopback (RFC 4291 §2.5.3). `new URL()` reports IPv6 hosts bracketed, so the
 *   brackets are stripped before comparing.
 *
 * Deliberately NOT loopback: private LAN ranges (10/8, 172.16/12, 192.168/16) and mDNS `*.local`
 * names — traffic to those crosses a real network, where plaintext is really exposed. `0.0.0.0` is
 * a wildcard bind address rather than a host any client can reach, so it is excluded too.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
