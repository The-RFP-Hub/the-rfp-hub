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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  const policy = contentSecurityPolicy("nonce123", "https://api.example.com/v1", undefined, false);

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

  it("names no third-party origin anywhere in the policy WHEN ANALYTICS IS OFF", () => {
    // The browser talks to one host. Google sign-in is a top-level navigation, not an embedded
    // widget, so it earns no allowance here either. The GA origins are the one exception, and
    // they have their own describe block below — this pins that an unset `NEXT_PUBLIC_GA_ID`
    // (every fork's default) still yields a policy naming no one.
    for (const directiveName of ["connect-src", "frame-src", "script-src", "img-src", "font-src"]) {
      const sources = directive(policy, directiveName)
        .split(" ")
        .filter((source) => source.startsWith("http") || source.startsWith("ws"));
      expect(sources).toEqual(directiveName === "connect-src" ? ["https://api.example.com"] : []);
    }
  });

  it("does not widen to a wildcard when the API URL is missing or malformed", () => {
    for (const bad of [undefined, "", "not a url"]) {
      const withoutApi = contentSecurityPolicy("n", bad, undefined, false);
      expect(directive(withoutApi, "connect-src")).toBe("'self'");
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

  it("SERVES ITS OWN FONTS — the typography did not cost a CSP relaxation", () => {
    // This site now uses three real typefaces where it used to use system stacks, and this is the
    // assertion that says it did not pay for them with the reader's privacy. `next/font`
    // downloads them at BUILD time and emits @font-face rules pointing at this origin, so no
    // browser ever asks a font CDN for anything and nobody's IP address reaches one because they
    // opened the directory. If a stylesheet link to a font host is ever added, this fails.
    expect(directive(policy, "font-src")).toBe("'self' data:");
    // A remote stylesheet is the other way a font CDN gets reached; `style-src` names no host.
    const styles = directive(policy, "style-src").split(" ");
    expect(styles.filter((source) => source.startsWith("http"))).toEqual([]);
  });
});

/**
 * THE ONE THIRD-PARTY THE POLICY MAY NAME, pinned exactly.
 *
 * Setting `NEXT_PUBLIC_GA_ID` is the deployment saying "this instance reports usage to Google
 * Analytics", and the header must open precisely the origins GA4 needs — the loader from
 * `googletagmanager.com`, hits to the two collection domains (wildcarded for Google's regional
 * `region1.`-style endpoints) — and not one origin more. The exact literals are the regression
 * guard: a future SDK update that "just needs one more host" has to show up here as a failing
 * test, the same way the auth vendor's eight origins once did.
 */
describe("the Google Analytics allowance", () => {
  const withGa = contentSecurityPolicy(
    "nonce123",
    "https://api.example.com/v1",
    "G-TEST123",
    false,
  );

  it("admits the gtag loader alongside the nonce, never 'unsafe-inline'", () => {
    expect(directive(withGa, "script-src")).toBe(
      "'self' 'nonce-nonce123' https://*.googletagmanager.com",
    );
  });

  it("admits Google's collection endpoints in connect-src and img-src only", () => {
    expect(directive(withGa, "connect-src")).toBe(
      "'self' https://api.example.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    );
    expect(directive(withGa, "img-src")).toBe(
      "'self' data: https://*.google-analytics.com https://*.googletagmanager.com",
    );
  });

  it("leaves every other directive exactly as strict as without analytics", () => {
    const without = contentSecurityPolicy(
      "nonce123",
      "https://api.example.com/v1",
      undefined,
      false,
    );
    for (const name of [
      "default-src",
      "style-src",
      "font-src",
      "frame-src",
      "worker-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]) {
      expect(directive(withGa, name)).toBe(directive(without, name));
    }
  });

  it("is absent for the empty string, not only for undefined", () => {
    // An operator clearing the variable in Vercel leaves "", and "" must mean OFF.
    const cleared = contentSecurityPolicy("n", "https://api.example.com", "", false);
    expect(cleared).not.toContain("google");
  });
});

/**
 * THE POLICY IS ONLY TRUE IF THE SOURCE AGREES WITH IT.
 *
 * A header that forbids a third-party font and a page that links one produce a broken page, not a
 * safe one — and the failure mode is a silent fallback to a system font that looks almost right.
 * The design mocks this frontend was built from DO carry a `fonts.googleapis.com` stylesheet link,
 * so this is a real transcription risk rather than a hypothetical one.
 */
describe("no third-party font is fetched at runtime", () => {
  const sourceRoot = join(process.cwd(), "src");

  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        found.push(...sourceFiles(full));
        continue;
      }
      if (/\.(ts|tsx|css)$/.test(entry)) found.push(full);
    }
    return found;
  }

  it("names no font CDN anywhere in src/", () => {
    const hosts = [["fonts", "googleapis", "com"].join("."), ["fonts", "gstatic", "com"].join(".")];
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const text = readFileSync(file, "utf8");
      for (const host of hosts) {
        if (text.includes(host)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares the three families in ONE module, through CSS variables", () => {
    // The stylesheet never names a family; it consumes `--font-display`, `--font-body` and
    // `--font-mono`. That is what keeps the self-hosting decision in a single reviewable place
    // instead of spread across every rule that sets a font.
    const fonts = readFileSync(join(sourceRoot, "lib/fonts.ts"), "utf8");
    expect(fonts).toContain("next/font/google");
    for (const variable of ["--font-display", "--font-body", "--font-mono"]) {
      expect(fonts).toContain(variable);
    }
    const css = readFileSync(join(sourceRoot, "app/globals.css"), "utf8");
    expect(css).toContain("var(--font-body)");
    expect(css).toContain("var(--font-display)");
    expect(css).toContain("var(--font-mono)");
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
    expect(contentSecurityPolicy("n0nce", "https://api.example.org", undefined, true)).toContain(
      "'unsafe-eval'",
    );

    // The shipped header is unchanged: `script-src` stays absolute. This is the assertion that stops
    // the dev allowance from quietly becoming a deployed one.
    const production = contentSecurityPolicy("n0nce", "https://api.example.org", undefined, false);
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).toContain("script-src 'self' 'nonce-n0nce';");
  });
});
