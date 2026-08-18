/**
 * The Content-Security-Policy, built here rather than written as a string in the proxy so it
 * can be unit-tested without a running server.
 *
 * WHAT THIS IS DEFENDING. Every listing this dashboard renders is publisher-supplied, and the
 * Standard says so out loud: `description` is "untrusted … sanitise before rendering". The first
 * line of defence is that nothing in this package ever calls `dangerouslySetInnerHTML` (a unit test
 * scans the source for it). This header is the second: even if some future component reintroduced
 * an injection, an injected inline `<script>` carries no nonce and does not run.
 *
 * THE TWO DELIBERATE RELAXATIONS, both named rather than buried:
 *
 *   `'unsafe-eval'` — `rfphub-validate` validates a submission in the browser with ajv, and ajv
 *   compiles a JSON Schema into a function with `new Function`. Without this the form loses its
 *   live validation and falls back to the server's 400 (the form handles that path, but it is a
 *   worse experience). The exposure this buys an attacker is narrow: nothing here ever evaluates a
 *   string it did not author, so there is no gadget to reach. Removing it means precompiling the
 *   Standard's schema with ajv's standalone code generator at build time, which is the right fix
 *   and is recorded in the README as follow-up work rather than pretended away.
 *
 *   `style-src 'unsafe-inline'` — the framework and the auth SDK both emit inline style
 *   attributes. Inline styles are not script execution; the prohibition that matters is on
 *   `script-src`, and that one is kept.
 *
 * `connect-src` is an ALLOWLIST that has to name the API's origin, so a deployment pointing at a
 * different API must rebuild — which is correct: a browser that may call any origin with the
 * user's bearer token is one exfiltration bug away from handing it over.
 */

/** Where the SDK's own iframe, popup and API live. Hard-coded because it is the vendor's, not ours. */
const PRIVY_ORIGINS = [
  "https://auth.privy.io",
  "https://*.privy.io",
  "https://*.rpc.privy.systems",
] as const;

/** The wallet-connection and bot-check origins the auth SDK reaches for during a login. */
const WALLET_ORIGINS = [
  "https://explorer-api.walletconnect.com",
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
] as const;

const CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The origin of `url`, or `null` when it is absent or unparseable.
 *
 * A missing or malformed `NEXT_PUBLIC_API_URL` must not silently widen the policy to `*`: it
 * produces a policy with no API origin at all, the fetches fail visibly, and the operator fixes
 * the variable. A quiet wildcard would be the worse failure — it would work.
 */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The whole header value, for one request's nonce and one deployment's API origin. */
export function contentSecurityPolicy(nonce: string, apiUrl: string | undefined): string {
  const api = originOf(apiUrl);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", `'nonce-${nonce}'`, "'unsafe-eval'", "'wasm-unsafe-eval'", CHALLENGE_ORIGIN],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // No remote images. A publisher-supplied `logoUrl` is rendered as a link, never as an <img>:
    // loading it would leak every dashboard reader's IP to whatever host a submitter names.
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(api ? [api] : []), ...PRIVY_ORIGINS, ...WALLET_ORIGINS]],
    [
      "frame-src",
      ["'self'", ...PRIVY_ORIGINS, CHALLENGE_ORIGIN, "https://verify.walletconnect.com"],
    ],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
