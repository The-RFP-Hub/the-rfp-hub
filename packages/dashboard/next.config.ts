import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const packageDir = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard is a BROWSER CLIENT of the API and nothing else.
 *
 * There are no Next route handlers, no server actions that talk to the API and no server-side
 * session: every authenticated request is made from the browser with the caller's own Privy access
 * token, so the API stays the single authorization authority. A server session here would be a
 * second one, and the two would disagree the first time a role changed.
 *
 * `output: "standalone"` keeps the deployable artifact a plain Node server, which is what the
 * README's manual deployment path assumes. Nothing in this package is generated at build time from
 * the API, so a build never needs it to be running.
 *
 * SECURITY HEADERS. The Content-Security-Policy is NOT here: it carries a per-request nonce and is
 * therefore set in `src/middleware.ts`, which is the only place that can mint one. The headers
 * below are the request-independent half, kept next to the build so a deployment that forgets to
 * configure its host still gets them.
 */
const securityHeaders = [
  // The dashboard shows one account's own data. Leaking the path it was on to a third-party site
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

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The workspace root, stated rather than inferred. In a monorepo — and especially in a git
  // worktree, where a second lockfile sits one directory up — the inference is ambiguous and the
  // build says so; a wrong guess would trace the wrong node_modules into the standalone output.
  outputFileTracingRoot: join(packageDir, "../.."),
  webpack: (config) => {
    // The auth SDK carries optional integrations for chains and mini-app hosts this dashboard does
    // not use, and their packages are optional peers we deliberately do not install. Resolving them
    // to `false` turns a "module not found" warning on every build into an explicit statement that
    // the integration is absent. It is unreachable at runtime: those code paths are behind login
    // methods this app does not enable.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@farcaster/mini-app-solana": false,
    };
    return config;
  },
  // `rfphub-validate` and `@the-rfp-hub/standard` are workspace packages consumed from source-built
  // ESM `dist`. They are pure (JSON Schema + ajv, no Node built-ins), so they bundle for the
  // browser; this tells Next to transpile them rather than treat them as opaque externals.
  transpilePackages: ["rfphub-validate", "@the-rfp-hub/standard"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
