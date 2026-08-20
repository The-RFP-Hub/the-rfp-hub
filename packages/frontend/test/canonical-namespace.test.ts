/**
 * @vitest-environment node
 *
 * THE CARVE-OUT, PINNED FROM BOTH SIDES.
 *
 * In production this package is what `https://ethrfps.app` resolves to, and that hostname is the
 * authority for every identifier the Standard publishes (`adr/0007`): `/schemas/`, `/meta/`,
 * `/registries/` and `/ns/`. The app therefore receives requests for URLs it must not answer, and
 * `next.config.ts` proxies them to the API instead. Two things can silently undo that, and this
 * file is one assertion for each:
 *
 *   1. THE PROXY GOES AWAY, or gains a prefix, or starts pointing somewhere that is not the API.
 *      Asserted as an exact list — a longer one is a decision, not a diff nobody reads.
 *   2. A ROUTE CLAIMS ONE OF THE PREFIXES. `src/app/schemas/page.tsx` is a plausible thing for
 *      somebody to add — a human-readable page about the schemas is a reasonable idea — and it
 *      would sit under an identifier. The `beforeFiles` placement means the proxy would still win
 *      at runtime, so this would not break resolution; it would create a route that can never be
 *      reached, which is how the carve-out gets argued away later. The directory is forbidden.
 *
 * `@vitest-environment node`: the rest of this suite runs under jsdom, where a module's own URL is
 * an `http:` URL — and `next.config.ts` calls `fileURLToPath(import.meta.url)` at module scope,
 * which refuses one. This file needs the real module URL, and needs no DOM.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig, { CANONICAL_PREFIXES, canonicalProxyRewrites } from "../next.config";

// `process.cwd()` rather than `import.meta.url` for symmetry with the other source-scanning suite
// here; vitest runs both with the package directory as the cwd.
const packageRoot = process.cwd();
const appRoot = join(packageRoot, "src", "app");

/** The four prefixes, written out rather than derived — this is the copy the config is checked against. */
const PREFIXES = ["schemas", "meta", "registries", "ns"] as const;

describe("the canonical namespace is proxied to the API", () => {
  const api = "https://api.example.com";

  it("proxies exactly the four reserved prefixes, and nothing else", () => {
    expect(canonicalProxyRewrites(api)).toEqual([
      { source: "/schemas/:path*", destination: `${api}/schemas/:path*` },
      { source: "/meta/:path*", destination: `${api}/meta/:path*` },
      { source: "/registries/:path*", destination: `${api}/registries/:path*` },
      { source: "/ns/:path*", destination: `${api}/ns/:path*` },
    ]);
  });

  it("names the same four prefixes the config exports", () => {
    expect([...CANONICAL_PREFIXES]).toEqual([...PREFIXES]);
  });

  it("sends them to the API's ORIGIN, dropping any path the variable carries", () => {
    // The canonical documents are mounted at the API's root, never under `/v1/`. A deployment that
    // sets `NEXT_PUBLIC_API_URL` with a path must not move the identifiers underneath it.
    const rewrites = canonicalProxyRewrites("https://api.example.com/v1/");
    expect(rewrites.map((rule) => rule.destination)).toEqual([
      `${api}/schemas/:path*`,
      `${api}/meta/:path*`,
      `${api}/registries/:path*`,
      `${api}/ns/:path*`,
    ]);
  });

  it("proxies nothing when the API URL is absent or unparseable, and does not throw", () => {
    // Mirrors `lib/csp.ts`: a missing variable narrows behaviour rather than inventing a target.
    expect(canonicalProxyRewrites(undefined)).toEqual([]);
    expect(canonicalProxyRewrites("")).toEqual([]);
    expect(canonicalProxyRewrites("not a url")).toEqual([]);
  });

  it("places them in beforeFiles, so no file in the app can be consulted first", async () => {
    process.env.NEXT_PUBLIC_API_URL = api;
    const rewrites = await nextConfig.rewrites?.();
    expect(Array.isArray(rewrites)).toBe(false);
    const { beforeFiles, afterFiles, fallback } = rewrites as {
      beforeFiles?: { source: string; destination: string }[];
      afterFiles?: unknown[];
      fallback?: unknown[];
    };
    expect(beforeFiles).toEqual(canonicalProxyRewrites(api));
    // The other two buckets are checked after the filesystem, which is the wrong side of this.
    expect(afterFiles ?? []).toEqual([]);
    expect(fallback ?? []).toEqual([]);
  });
});

/**
 * Every route path `src/app` publishes, as a leading path segment.
 *
 * Route groups (`(marketing)`) and parallel slots (`@modal`) contribute NO URL segment, so a
 * directory inside one is still top-level as far as a URL is concerned — which is exactly where a
 * shadowing route would be easiest to miss. Private folders (`_components`) publish nothing and are
 * skipped, as is anything below a segment that is already a real one: only the FIRST segment can
 * collide with a reserved prefix.
 */
function firstRouteSegments(directory: string): string[] {
  const segments: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (!statSync(join(directory, entry)).isDirectory()) continue;
    if (entry.startsWith("_")) continue;
    if (entry.startsWith("(") || entry.startsWith("@")) {
      segments.push(...firstRouteSegments(join(directory, entry)));
      continue;
    }
    segments.push(entry);
  }
  return segments;
}

describe("no app route shadows the canonical namespace", () => {
  const segments = firstRouteSegments(appRoot);

  it("finds an app tree to scan at all", () => {
    // Without this, a move that emptied `src/app` would make the assertion below vacuously pass.
    expect(segments.length).toBeGreaterThan(5);
  });

  it("has no route directory spelling a reserved prefix", () => {
    const shadowing = segments.filter((segment) =>
      (PREFIXES as readonly string[]).includes(segment),
    );
    expect(shadowing).toEqual([]);
  });

  it("has no `public/` directory that could serve a file at one of them", () => {
    // Static files are checked after `beforeFiles`, so this could not break resolution either — but
    // `public/schemas/opportunity.schema.json` would be a second, unversioned copy of a frozen
    // document, and the reason there is no `public/` at all is worth keeping true.
    let entries: string[] | null = null;
    try {
      entries = readdirSync(join(packageRoot, "public"));
    } catch {
      entries = null;
    }
    expect(
      entries?.filter((entry) => (PREFIXES as readonly string[]).includes(entry)) ?? [],
    ).toEqual([]);
  });

  it("still says so in the config's own prose", () => {
    // The comment IS the explanation a future reader gets before deleting the rewrite. If the
    // reservation is ever lifted, this fails and the ADR has to be revisited on purpose.
    const config = readFileSync(join(packageRoot, "next.config.ts"), "utf8");
    expect(config).toContain("beforeFiles");
    for (const prefix of PREFIXES) expect(config).toContain(`"${prefix}"`);
  });
});
