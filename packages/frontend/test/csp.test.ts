/**
 * The header is generated, so it can be asserted.
 *
 * THIS FILE CHANGED SIDES. It used to pin `'unsafe-eval'` as PRESENT — deliberately, so that
 * removing it would be a visible decision with a failing test attached rather than a quiet
 * regression of the submit form's live validation. The auth migration removed the last thing that
 * needed it, so the assertion is now inverted: `'unsafe-eval'` and `'wasm-unsafe-eval'` must be
 * ABSENT, and re-adding either one is what has to argue for itself.
 *
 * The `connect-src` literal is pinned exactly. It named eight third-party origins for the previous
 * auth SDK and its wallet connector; it now names the API and nothing else, and an exact literal is
 * how a re-widening shows up as a failure rather than as a longer string nobody reads.
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
  // THE DEPLOYED POLICY, asserted explicitly rather than inherited from `NODE_ENV`.
  //
  // `contentSecurityPolicy` widens `script-src` for the dev server, whose eval-based devtool the
  // production header must never permit — so a suite that let the ambient environment pick would be
  // asserting whichever policy it happened to be run under. Passing `false` names the one these
  // tests are about; the dev allowance has its own test at the bottom of this file.
  const policy = contentSecurityPolicy("nonce123", "https://api.example.com/v1", false);

  it("nonces scripts and never allows inline ones", () => {
    const scripts = directive(policy, "script-src");
    expect(scripts).toContain("'nonce-nonce123'");
    expect(scripts).not.toContain("'unsafe-inline'");
  });

  it("permits NO form of eval — the single largest win of the auth migration", () => {
    // Inverted from what this file asserted before. `rfphub-validate` is consumed as a prebuilt
    // module and the production bundle compiles no schema at runtime, so nothing on the page needs
    // to turn a string into code. Re-adding either value means an attacker who can get a string
    // into this origin can execute it — with a 90-day session token sitting in localStorage.
    const scripts = directive(policy, "script-src");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'wasm-unsafe-eval'");
    expect(scripts).toBe("'self' 'nonce-nonce123'");
  });

  it("limits connect-src to the configured API ORIGIN and nothing else", () => {
    expect(directive(policy, "connect-src")).toBe("'self' https://api.example.com");
    const sources = directive(policy, "connect-src").split(" ");
    // The path is dropped: a source expression is an origin, and `https://api.example.com/v1` would
    // be a subtly different (and narrower-looking, but not actually enforced) thing.
    expect(sources.some((source) => source.includes("/v1"))).toBe(false);
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https:");
  });

  it("names no third-party origin anywhere in the policy", () => {
    // The browser talks to one host. Google sign-in is a top-level navigation, not an embedded
    // widget, so it earns no allowance here either.
    for (const directiveName of ["connect-src", "frame-src", "script-src", "img-src", "font-src"]) {
      const sources = directive(policy, directiveName)
        .split(" ")
        .filter((source) => source.startsWith("http") || source.startsWith("ws"));
      expect(sources).toEqual(directiveName === "connect-src" ? ["https://api.example.com"] : []);
    }
  });

  it("does not widen to a wildcard when the API URL is missing or malformed", () => {
    for (const bad of [undefined, "", "not a url"]) {
      expect(directive(contentSecurityPolicy("n", bad, false), "connect-src")).toBe("'self'");
    }
  });

  it("refuses framing, embedding and workers it does not need", () => {
    expect(directive(policy, "frame-ancestors")).toBe("'none'");
    expect(directive(policy, "object-src")).toBe("'none'");
    expect(directive(policy, "base-uri")).toBe("'self'");
    // Nothing is embedded any more — this was `'self'` plus five vendor origins.
    expect(directive(policy, "frame-src")).toBe("'none'");
    // `blob:` is a script-execution channel and no worker here needs one.
    expect(directive(policy, "worker-src")).toBe("'self'");
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
    const result = readConfig({ apiUrl: "https://api.example.com/" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.apiBaseUrl).toBe("https://api.example.com");
  });

  it("needs exactly ONE variable, now that the API issues the sessions", () => {
    // There used to be a second — a third-party auth application id, which had to differ per
    // environment or two environments' users landed in one identity pool. It is gone, and so is
    // that whole class of misconfiguration.
    const result = readConfig({ apiUrl: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.variable)).toEqual(["NEXT_PUBLIC_API_URL"]);
    }
  });

  it("rejects a non-http API URL instead of defaulting to something that works", () => {
    expect(readConfig({ apiUrl: "ftp://api.example.com" }).ok).toBe(false);
  });
});

describe("the development allowance", () => {
  it("permits eval for the dev server, and never in production", () => {
    // `next dev` compiles with an eval-based devtool, so the client bundle evaluates strings. Under
    // the production policy the browser refuses and the page hangs before it can restore a session —
    // which is exactly what `pnpm dev` did, and what the end-to-end suite caught.
    expect(contentSecurityPolicy("n0nce", "https://api.example.org", true)).toContain(
      "'unsafe-eval'",
    );

    // The shipped header is unchanged: `script-src` stays absolute. This is the assertion that stops
    // the dev allowance from quietly becoming a deployed one.
    const production = contentSecurityPolicy("n0nce", "https://api.example.org", false);
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).toContain("script-src 'self' 'nonce-n0nce';");
  });
});
