/**
 * The pure, testable half of `/logos/[slug]`: which URLs this origin will fetch on a publisher's
 * behalf, and which response content types it will pass through to a reader.
 *
 * WHY THIS EXISTS. `img-src` in `src/lib/csp.ts` is `'self'` and `data:` only — a publisher-named
 * `logoUrl` loaded straight into an `<img>` would hand that host every reader's IP. Proxying the
 * bytes through this origin keeps that promise while still showing a mark. Doing so safely means
 * this server, not a reader's browser, is the one making the outbound request, so the SSRF surface
 * moves here: `isSafeLogoUrl` has to refuse anything that could point the fetch at this deployment's
 * own network rather than the public internet.
 *
 * `isSafeLogoUrl` deliberately does NOT resolve DNS. Resolving here and then trusting the result
 * is a TOCTOU gap (the name can repoint between the check and the `fetch`); the honest fix needs a
 * fetch-time guard on the connecting socket, which this package does not have. Instead it rejects
 * the cheap, reliable signals that never legitimately point at a public logo host: literal IPs
 * (v4 and v6, including the untidy forms like `0x7f000001` or `017700000001` a browser would still
 * parse as loopback), `localhost`, and the reserved `.local`/`.internal` TLD-like suffixes — plus
 * any port other than the implicit default or the standard 80/443.
 */

const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;

export type AllowedLogoContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** 512 KB, the cap named in the feature spec — checked against both `content-length` and bytes read. */
export const MAX_LOGO_BYTES = 512 * 1024;

/** How long the server-side fetch of a publisher's logo is allowed to hang before giving up. */
export const LOGO_FETCH_TIMEOUT_MS = 5_000;

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Matches a bare IPv4 literal, decimal octets only — `192.168.0.1`, not a hostname. */
const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * A hostname is "reserved" when it can only ever mean a host on the machine running this server
 * or its private network, never a publisher's public logo host.
 */
function isReservedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "0.0.0.0") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.endsWith(".localhost")) return true;
  // Bracketed IPv6 literal: `[::1]`, `[fe80::1]`, etc. — any literal address, not just loopback,
  // since this proxy has no business dialing a bare IP at all.
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (IPV4_LITERAL.test(host)) return true;
  // Alternate numeric encodings a browser (and Node's URL parser) still treats as an IP: hex
  // (`0x7f000001`), octal-looking dotted parts (`017700000001`), or a single decimal integer
  // (`2130706433`). None of these are a hostname a real logo host would use.
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  if (/^0[0-7]+(\.\d+){0,3}$/.test(host)) return true;
  return false;
}

/**
 * Is `url` a logo this server will fetch on a reader's behalf?
 *
 * http(s) only, no reserved/private/loopback host, no non-standard port. Anything else — including
 * an unparseable string — is rejected rather than guessed at.
 */
export function isSafeLogoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!ALLOWED_PORTS.has(parsed.port)) return false;
  if (!parsed.hostname) return false;
  if (isReservedHostname(parsed.hostname)) return false;
  return true;
}

/** Is `contentType` (the response's raw `Content-Type` header value) one this proxy will serve? */
export function acceptableLogoContentType(
  contentType: string | null,
): AllowedLogoContentType | null {
  if (!contentType) return null;
  // Strip a `; charset=...` or similar parameter — only the media type itself is checked.
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  const match = ALLOWED_CONTENT_TYPES.find((allowed) => allowed === mediaType);
  return match ?? null;
}
