/**
 * The outbound fetch for verification-assist: the one place this service connects to an address a
 * stranger chose.
 *
 * THE ATTACK THIS IS BUILT AGAINST is not "a submitter typed a private IP" — that is trivial to
 * check. It is DNS rebinding: resolve `evil.example` to a public address for the check, then to
 * `169.254.169.254` for the connection, and the instance metadata endpoint answers with
 * credentials. `dns.lookup()` followed by a plain `fetch(url)` resolves TWICE and is exactly that
 * hole; re-validating each redirect target does not close it, because the gap is between the check
 * and the socket, not between hops.
 *
 * So the address is PINNED. Each hop resolves once, `modules/shared/ssrf.ts` classifies the
 * resulting address, and the connection is made through an undici `Agent` whose `connect.lookup`
 * can only ever return that one validated address. `servername` is still set from the hostname, so
 * TLS SNI and certificate validation continue to target the real name rather than the IP.
 *
 * The rest is the ordinary list, and each item is here because it is a way in or a way to be hurt:
 *
 *   scheme allowlist       `file:` reads the container's filesystem; `gopher:`/`dict:` are the
 *                          classic protocol-smuggling primitives.
 *   manual redirects       3 hops, each re-resolved, re-validated and re-pinned. Automatic
 *                          following would connect to hop 2 without any of that.
 *   2 MiB streamed cap     the body is bounded as it arrives, not after; the stream is destroyed at
 *                          the cap rather than drained.
 *   content-type allowlist a 4 GB video is not a source page, and neither is a binary.
 *   no credentials         nothing constructs an `Authorization`, a cookie or a referer. The
 *                          request carries only what is written below.
 *
 * `VERIFY_ALLOW_PRIVATE_HOSTS` turns the address check off for exactly one loopback end-to-end
 * test, and `config.ts` refuses to start a production process with it set.
 *
 * The TRANSPORT is injectable so extraction and diff tests run against fixtures without a socket.
 * The address validation lives in the real transport, because it is a fact about a resolved
 * address; the scheme check and the redirect walk live out here, so a fixture transport still
 * exercises them.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, ProxyAgent, request } from "undici";
import { config as defaultConfig } from "../../../config.js";
import { classifyAddress, isAllowedScheme } from "../../shared/ssrf.js";

/** What a source page may be served as. Anything else is refused before the body is read. */
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/** Identifies this project's own traffic to the sites it checks — and to our own analytics. */
export const VERIFIER_USER_AGENT =
  "RFPHubVerifier/1.0 (+https://github.com/The-RFP-Hub/the-rfp-hub)";

export interface TransportOptions {
  timeoutMs: number;
  maxBytes: number;
  headers: Record<string, string>;
  allowPrivateHosts: boolean;
}

/** One HTTP round trip, with redirects NOT followed. The seam the fixture tests replace. */
export interface HopResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** The raw bytes, already capped by the transport. */
  bytes: Buffer;
  truncated: boolean;
}

export type SourceTransport = (url: string, options: TransportOptions) => Promise<HopResponse>;

/**
 * The `all: true` half of Node's `lookup` contract — an array of addresses rather than two spread
 * arguments. Named here because the type undici publishes for `connect.lookup` describes only the
 * legacy shape, so the cast at the call site needs something honest to cast TO.
 */
type LookupAllCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: { address: string; family: number }[],
) => void;

/** A refusal, carrying the category so a failed verification run can record WHY. */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly url?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}

export interface FetchedSource {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** The decoded body. */
  text: string;
  /**
   * `sha256` of the RAW BYTES that produced `text` — including the case where the cap truncated
   * them, which `truncated` says. It is a digest of what was read, never of what was served.
   */
  sha256: string;
  truncated: boolean;
  /** Every hop after the first, in order. Empty when the first response was the answer. */
  redirects: string[];
}

export interface FetchSourceOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivateHosts?: boolean;
  /** Injected by the fixture suites. A deployment always uses the pinning transport. */
  transport?: SourceTransport;
}

const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Fetch one source page, following at most `maxRedirects` hops by hand.
 *
 * Every hop goes back through the scheme check and back through the transport, which is where the
 * address is resolved, validated and pinned — so "a public host that redirects to loopback" is
 * refused at hop 2 with the same machinery that refuses loopback at hop 1.
 */
export async function fetchSource(
  url: string,
  options: FetchSourceOptions = {},
): Promise<FetchedSource> {
  const timeoutMs = options.timeoutMs ?? defaultConfig.verification.timeoutMs;
  const maxBytes = options.maxBytes ?? defaultConfig.verification.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivateHosts =
    options.allowPrivateHosts ?? defaultConfig.verification.allowPrivateHosts;
  const transport = options.transport ?? undiciTransport;

  const requestedUrl = url;
  const redirects: string[] = [];
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = parseTarget(current);
    const response = await transport(target.href, {
      timeoutMs,
      maxBytes,
      allowPrivateHosts,
      // Everything the request carries, in one literal. No cookie jar, no `Authorization`, no
      // `Referer` — a verifier that forwarded a credential would be handing it to whoever the
      // submitter pointed it at.
      headers: {
        "user-agent": VERIFIER_USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
        "accept-language": "en",
      },
    });

    if (isRedirect(response.status)) {
      const location = headerValue(response.headers, "location");
      if (location === undefined) {
        throw new SourceFetchError(
          `HTTP ${response.status} with no Location header`,
          "redirect_without_location",
          target.href,
          response.status,
        );
      }
      if (hop === maxRedirects) {
        throw new SourceFetchError(
          `more than ${maxRedirects} redirects`,
          "too_many_redirects",
          target.href,
          response.status,
        );
      }
      current = new URL(location, target.href).href;
      redirects.push(current);
      continue;
    }

    const contentType = headerValue(response.headers, "content-type") ?? null;
    assertUsableContentType(contentType, target.href, response.status);

    return {
      requestedUrl,
      finalUrl: target.href,
      status: response.status,
      contentType,
      text: decode(response.bytes, contentType),
      sha256: createHash("sha256").update(response.bytes).digest("hex"),
      truncated: response.truncated,
      redirects,
    };
  }

  // Unreachable: the loop either returns or throws, and the hop budget is checked inside it.
  throw new SourceFetchError("redirect loop did not terminate", "too_many_redirects", current);
}

/** The URL, if it is one this fetcher will follow at all. */
function parseTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceFetchError(`${JSON.stringify(url)} is not a URL`, "invalid_url", url);
  }
  if (!isAllowedScheme(parsed.protocol)) {
    throw new SourceFetchError(
      `the ${parsed.protocol} scheme is not fetched (only http and https are)`,
      "scheme_not_allowed",
      parsed.href,
    );
  }
  return parsed;
}

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function assertUsableContentType(contentType: string | null, url: string, status: number): void {
  if (contentType === null) return; // absent is not wrong; it is simply unstated
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.includes(media)) {
    throw new SourceFetchError(
      `${JSON.stringify(media)} is not a source page (expected one of ${ALLOWED_CONTENT_TYPES.join(", ")})`,
      "content_type_not_allowed",
      url,
      status,
    );
  }
}

/**
 * Bytes → text, honouring a `charset` the response declared.
 *
 * An unknown label falls back to UTF-8 rather than failing: a mislabelled page is still a page, and
 * the worst case is a few mangled characters in a snapshot a human reads.
 */
function decode(bytes: Buffer, contentType: string | null): string {
  const charset = /charset=([^;]+)/i
    .exec(contentType ?? "")?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (charset && charset.toLowerCase() !== "utf-8" && charset.toLowerCase() !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label — fall through to UTF-8.
    }
  }
  return bytes.toString("utf8");
}

/**
 * Resolve a hostname once and validate what comes back.
 *
 * Every returned address is classified, and the FIRST allowed one is pinned. A host that resolves
 * to a mix of public and private addresses is a rebinding attempt or a misconfiguration; taking the
 * public one and pinning it means the connection cannot land on the other.
 */
async function resolvePinned(
  hostname: string,
  allowPrivateHosts: boolean,
): Promise<{ address: string; family: number }> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  const candidates = literal
    ? [{ address: bare, family: literal }]
    : await dnsLookup(bare, { all: true }).catch(() => {
        throw new SourceFetchError(`${hostname} does not resolve`, "dns_failure", hostname);
      });

  if (candidates.length === 0) {
    throw new SourceFetchError(`${hostname} resolved to no addresses`, "dns_failure", hostname);
  }
  if (allowPrivateHosts) {
    const first = candidates[0] as { address: string; family: number };
    return { address: first.address, family: first.family };
  }

  const verdicts = candidates.map((c) => ({ ...c, verdict: classifyAddress(c.address) }));
  const allowed = verdicts.find((c) => c.verdict.allowed);
  if (!allowed) {
    const refused = verdicts[0];
    throw new SourceFetchError(
      refused?.verdict.reason ?? `${hostname} resolves to an address that is not fetched`,
      `address_refused:${refused?.verdict.category ?? "unknown"}`,
      hostname,
    );
  }
  return { address: allowed.address, family: allowed.family };
}

/**
 * The real transport: one request, to one validated and pinned address, with the body bounded as it
 * streams.
 *
 * A fresh `Agent` per hop, destroyed in `finally`. Reusing a pooled connection across hops would
 * mean hop 2 travelling over a socket opened for hop 1's address, which is the pinning undone.
 */
export const undiciTransport: SourceTransport = async (url, options) => {
  const target = new URL(url);
  const pinned = await resolvePinned(target.hostname, options.allowPrivateHosts);

  const proxy = defaultConfig.verification.egressProxy;
  const dispatcher = proxy
    ? // A configured egress proxy is the network-layer backstop this check should not be alone in
      // providing (D-13). The proxy resolves and connects, so the pin above becomes defence in
      // depth rather than the enforcement point, and the proxy's own egress rules are what hold.
      new ProxyAgent({
        uri: proxy,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      })
    : new Agent({
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
        connect: {
          timeout: options.timeoutMs,
          // The whole point: whatever undici asks to resolve, it gets the address that was
          // validated a moment ago and nothing else.
          //
          // BOTH CALLBACK SHAPES, because the caller decides which one it asked for. `net.connect`
          // runs with `autoSelectFamily` on by default from Node 20, and that path calls `lookup`
          // with `all: true` and expects an ARRAY of `{address, family}`; the legacy path expects
          // the two values spread as arguments. Answering the legacy shape to an `all: true` call
          // put a string where an array was expected, and the socket died with
          // "Invalid IP address: undefined" — a total failure of source verification against every
          // real hostname, invisible to the suite because fixture URLs use the 127.0.0.1 LITERAL
          // (an IP literal never reaches `lookup` at all).
          //
          // The pin is unchanged either way: one address, the one that was validated, and nothing
          // else for the resolver to choose from.
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions?.all === true) {
              (callback as unknown as LookupAllCallback)(null, [
                { address: pinned.address, family: pinned.family },
              ]);
              return;
            }
            callback(null, pinned.address, pinned.family);
          },
          // SNI and certificate validation still target the NAME, so pinning the address does not
          // silently accept a certificate for something else.
          servername: isIP(target.hostname) ? undefined : target.hostname,
        },
      });

  try {
    const response = await request(target.href, {
      method: "GET",
      headers: options.headers,
      dispatcher,
      // No redirect interceptor is installed on this dispatcher, so undici returns the 3xx as-is —
      // which is what `fetchSource` needs: every hop is re-resolved, re-validated and re-pinned by
      // hand, and an automatically-followed hop would connect without any of that.
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
      // Reaching the cap exactly is not truncation. Keep reading until the stream ends or one more
      // byte arrives; only the latter proves that the representation exceeded the recorded bytes.
      if (total + buffer.length > options.maxBytes) {
        chunks.push(buffer.subarray(0, options.maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
    // Stop the download at the cap rather than draining it: the cap exists to bound what this
    // process pulls in, and reading the rest to be polite would defeat it.
    response.body.destroy();

    return {
      status: response.statusCode,
      headers: response.headers as Record<string, string | string[] | undefined>,
      bytes: Buffer.concat(chunks),
      truncated,
    };
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|aborted/i.test(message);
    throw new SourceFetchError(
      `${target.href}: ${message}`,
      timedOut ? "timeout" : "transport_failure",
      target.href,
    );
  } finally {
    await dispatcher.destroy();
  }
};
