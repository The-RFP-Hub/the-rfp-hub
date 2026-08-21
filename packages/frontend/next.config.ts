import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { originOf } from "./src/lib/csp";

const packageDir = dirname(fileURLToPath(import.meta.url));

/**
 * The frontend is a BROWSER CLIENT of the API and nothing else.
 *
 * There are no Next route handlers, no server actions that talk to the API and no server-side
 * session: every authenticated request is made from the browser with the caller's own session
 * token, so the API stays the single authorization authority. A server session here would be a
 * second one, and the two would disagree the first time a role changed.
 *
 * `output: "standalone"` keeps the deployable artifact a plain Node server, which is what the
 * README's manual deployment path assumes. Nothing in this package is generated at build time from
 * the API, so a build never needs it to be running.
 *
 * SECURITY HEADERS. The Content-Security-Policy is NOT here: it carries a per-request nonce and is
 * therefore set in `src/proxy.ts`, which is the only place that can mint one. The headers
 * below are the request-independent half, kept next to the build so a deployment that forgets to
 * configure its host still gets them.
 */
const securityHeaders = [
  // The frontend shows one account's own data. Leaking the path it was on to a third-party site
  // would leak entry ids to whatever a publisher clicks through to.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // No feature here needs any of these, and a page that renders publisher-supplied URLs should not
  // be able to ask for them.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

/**
 * THE FOUR PATH PREFIXES THIS SITE DOES NOT OWN.
 *
 * `adr/0007` reserves the apex — `ethrfps.app` — for the Standard and its site, and mints every
 * identifier the spec publishes underneath it: schema `$id`s under `/schemas/`, the meta-schema
 * under `/meta/`, the registry entry schema under `/registries/`, and the versionless vocabulary
 * namespace under `/ns/`. Those strings are forever. This package is the spec's site, and in
 * production it is what the apex resolves to — which makes these four prefixes paths this app
 * receives and must not answer.
 *
 * PROXIED, NEVER REDIRECTED. An identifier that 301s is an identifier that resolves somewhere
 * else: a JSON Schema `$id` must dereference to the document at that exact URL, and a validator
 * that followed a redirect would cache the bytes under the target's URL, not the identifier's.
 * A rewrite is the one mechanism that keeps the URL and the bytes together.
 *
 * IN `beforeFiles`, so the proxy is decided before the filesystem is consulted at all — a route
 * added here later cannot quietly take an identifier path. That is belt; the braces are
 * `test/canonical-namespace.test.ts`, which fails if `src/app` ever grows a directory that spells
 * one of these.
 *
 * `/ns/` is included even though the API serves nothing there yet: `adr/0007` leaves "should the
 * vocabulary namespace dereference" open, and the carve-out is what makes answering it later a
 * change to the API alone. Until then the prefix 404s from the API, which is the honest answer —
 * an app page rendered at a vocabulary IRI would not be.
 */
export const CANONICAL_PREFIXES = Object.freeze(["schemas", "meta", "registries", "ns"] as const);

/** Next exports no public alias for one rewrite entry; this is the half of its shape used here. */
export interface ProxyRewrite {
  source: string;
  destination: string;
}

/**
 * Where the canonical documents are proxied FROM this app TO the API.
 *
 * The API's ORIGIN, not `NEXT_PUBLIC_API_URL` verbatim: the canonical documents are mounted at the
 * API's root rather than under `/v1/` — identifiers are not API resources and must not carry an API
 * version (`packages/api/src/modules/routes/canonical`) — so a value that carries a path would send
 * `/schemas/…` to the wrong place. `originOf` is the same parser the CSP's `connect-src` uses, so
 * the origin this proxies to and the origin the browser is permitted to call cannot come out
 * different.
 *
 * A MISSING VALUE PRODUCES NO REWRITES, and nothing throws. That is how the rest of this package
 * treats the variable's absence — `lib/config.ts` reports it on screen, `lib/csp.ts` narrows the
 * policy instead of widening it — and a config that threw at import would make a build the only
 * way to discover an unset variable. Without the value there is no API to proxy to; the prefixes
 * then 404 from this app, which is exactly what they did before it had them.
 *
 * Takes the URL rather than reading `process.env` so the rules are testable, and is read at call
 * time rather than captured at module load so a test can state the value it is asserting about.
 */
export function canonicalProxyRewrites(apiUrl: string | undefined): ProxyRewrite[] {
  const origin = originOf(apiUrl);
  if (!origin) return [];
  return CANONICAL_PREFIXES.map((prefix) => ({
    // `:path*` is zero-or-more segments, so `/schemas` itself proxies too, not only what is
    // below it. The destination repeats the prefix: this is a proxy, not a rebasing.
    source: `/${prefix}/:path*`,
    destination: `${origin}/${prefix}/:path*`,
  }));
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The workspace root, stated rather than inferred. In a monorepo — and especially in a git
  // worktree, where a second lockfile sits one directory up — the inference is ambiguous and the
  // build says so; a wrong guess would trace the wrong node_modules into the standalone output.
  outputFileTracingRoot: join(packageDir, "../.."),
  // NO `webpack` OVERRIDE. There used to be one, aliasing an optional wallet integration to `false`
  // to silence a "module not found" warning the previous auth SDK produced on every build. The SDK
  // is gone and so is the warning: the auth client this package now uses pulls in no chain or
  // mini-app peers at all, so there is nothing left to stub out.
  //
  // `rfphub-validate` and `@the-rfp-hub/standard` are workspace packages consumed from source-built
  // ESM `dist`. They are pure (JSON Schema + ajv, no Node built-ins), so they bundle for the
  // browser; this tells Next to transpile them rather than treat them as opaque externals.
  transpilePackages: ["rfphub-validate", "@the-rfp-hub/standard"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return { beforeFiles: canonicalProxyRewrites(process.env.NEXT_PUBLIC_API_URL) };
  },
};

export default nextConfig;
