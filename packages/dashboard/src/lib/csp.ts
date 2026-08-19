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
 * IT MATTERS MORE THAN IT USED TO. The session token in `localStorage` is now a 90-day credential
 * rather than an access token of about an hour (`lib/auth-client.ts` states that trade in full), so
 * the value of keeping arbitrary script off this origin went up at the same moment this policy got
 * strong enough to do it.
 *
 * WHAT THIS POLICY NO LONGER CONTAINS, and why each removal is real rather than tidying:
 *
 *   `'unsafe-eval'` / `'wasm-unsafe-eval'` — these were here for ajv, which compiled the Standard's
 *   JSON Schema into a function with `new Function` so the submit form could validate in the
 *   browser. They are gone, and the production build is green without them: `rfphub-validate` is
 *   consumed as a prebuilt ESM module and Next's production bundle evaluates no schema at runtime.
 *   (Next's DEV server does use eval for its own tooling; that is a dev-server property and not a
 *   reason to widen the header a deployment ships.) This is the largest single change here — with
 *   them present, an attacker who could get a string into the page could execute it.
 *
 *   Every third-party origin. `connect-src` named three of the previous auth vendor's hosts and
 *   five WalletConnect ones; `frame-src` named those plus a bot-check origin. All are gone because
 *   the browser now talks to exactly one host — the API — and embeds nothing. Google sign-in does
 *   not reappear here: it is a top-level navigation out and a top-level redirect back, not an
 *   embedded widget, so it needs no CSP allowance at all.
 *
 *   `frame-src 'self'` → `'none'` and `worker-src 'self' blob:` → `'self'`. Neither capability is
 *   used any more, and `blob:` in `worker-src` is a script-execution channel.
 *
 * The one remaining relaxation is named rather than buried: `style-src 'unsafe-inline'`, because the
 * framework emits inline style attributes. Inline styles are not script execution; the prohibition
 * that matters is on `script-src`, and that one is now absolute.
 *
 * `connect-src` is an ALLOWLIST that has to name the API's origin, so a deployment pointing at a
 * different API must rebuild — which is correct: a browser that may call any origin with the user's
 * session token is one exfiltration bug away from handing it over.
 */

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
export function contentSecurityPolicy(
  nonce: string,
  apiUrl: string | undefined,
  /**
   * The DEV SERVER's one allowance, and the reason it is a parameter rather than a constant.
   *
   * `next dev` compiles modules with an eval-based devtool: the client bundle evaluates strings as
   * JavaScript, and under the policy above the browser refuses, the bundle never initialises and the
   * page hangs at "restoring session…". That is not a hypothetical — it is what `pnpm dev` did until
   * this parameter existed, and what the end-to-end suite hit on its first run against the tightened
   * policy.
   *
   * The deployed header is UNCHANGED. `script-src` stays absolute in production: this widens the
   * policy only when the process is not a production build, so a deployment can never ship it. The
   * alternative — dropping `'unsafe-eval'` back into the shipped policy — would have handed an
   * attacker who can get a string into the page the ability to execute it, to fix a dev-server
   * problem.
   */
  development = process.env.NODE_ENV !== "production",
): string {
  const api = originOf(apiUrl);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, ...(development ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // No remote images. A publisher-supplied `logoUrl` is rendered as a link, never as an <img>:
    // loading it would leak every dashboard reader's IP to whatever host a submitter names.
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'", "data:"]],
    // The API, and nothing else. Both halves of this app talk to exactly one host.
    ["connect-src", ["'self'", ...(api ? [api] : [])]],
    ["frame-src", ["'none'"]],
    ["worker-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
