/**
 * The header is generated, so it can be asserted. The three properties worth pinning are the ones a
 * well-meaning edit would break: scripts have no `'unsafe-inline'`, the page cannot be framed, and
 * `connect-src` names the configured API rather than everything.
 */
import { readConfig } from "@/lib/config";
import { contentSecurityPolicy, originOf } from "@/lib/csp";
import { describe, expect, it } from "vitest";

const directive = (policy: string, name: string): string =>
  policy
    .split("; ")
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1) ?? "";

describe("contentSecurityPolicy", () => {
  const policy = contentSecurityPolicy("nonce123", "https://api.example.com/v1");

  it("nonces scripts and never allows inline ones", () => {
    const scripts = directive(policy, "script-src");
    expect(scripts).toContain("'nonce-nonce123'");
    expect(scripts).not.toContain("'unsafe-inline'");
  });

  it("allows eval, which is what the Standard's validator needs in the browser", () => {
    // Documented in lib/csp.ts. Asserted so that removing it is a deliberate change with a failing
    // test attached, rather than a quiet regression of the submit form's live validation.
    expect(directive(policy, "script-src")).toContain("'unsafe-eval'");
  });

  it("limits connect-src to the configured API ORIGIN, not the whole URL", () => {
    const sources = directive(policy, "connect-src").split(" ");
    expect(sources).toContain("https://api.example.com");
    // The path is dropped: a source expression is an origin, and `https://api.example.com/v1` would
    // be a subtly different (and narrower-looking, but not actually enforced) thing.
    expect(sources.some((source) => source.includes("/v1"))).toBe(false);
    // The vendor entries are host-wildcarded subdomains of THEIR domains. A bare `*` — anywhere the
    // browser could reach — is what must never appear.
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https:");
  });

  it("does not widen to a wildcard when the API URL is missing or malformed", () => {
    for (const bad of [undefined, "", "not a url"]) {
      const connect = directive(contentSecurityPolicy("n", bad), "connect-src");
      expect(connect).toBe(
        "'self' https://auth.privy.io https://*.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org",
      );
    }
  });

  it("refuses framing and object embedding outright", () => {
    expect(directive(policy, "frame-ancestors")).toBe("'none'");
    expect(directive(policy, "object-src")).toBe("'none'");
    expect(directive(policy, "base-uri")).toBe("'self'");
  });

  it("loads no remote images, so a submitted logo URL cannot phone home", () => {
    expect(directive(policy, "img-src")).toBe("'self' data:");
  });
});

describe("originOf", () => {
  it("reduces a URL to its origin and refuses anything that is not one", () => {
    expect(originOf("https://api.example.com/v1/")).toBe("https://api.example.com");
    expect(originOf("nonsense")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("readConfig", () => {
  it("accepts a complete configuration and trims the trailing slash", () => {
    const result = readConfig({ apiUrl: "https://api.example.com/", privyAppId: "app-1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.apiBaseUrl).toBe("https://api.example.com");
  });

  it("names every missing variable rather than failing on the first", () => {
    const result = readConfig({ apiUrl: undefined, privyAppId: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.variable)).toEqual([
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_PRIVY_APP_ID",
      ]);
    }
  });

  it("rejects a non-http API URL instead of defaulting to something that works", () => {
    const result = readConfig({ apiUrl: "ftp://api.example.com", privyAppId: "app-1" });
    expect(result.ok).toBe(false);
  });
});
