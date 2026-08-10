/**
 * PURE config tests. `src/config.ts` is where an unset or half-supplied environment turns into
 * runtime behaviour, and each reader below exists because the naive version got something wrong:
 * `Number("")` is 0 rather than NaN, an unbounded pg pool is not a neutral default on a shared
 * database instance, and a published `servers[0].url` has no safe fallback to guess at.
 */
import { describe, expect, it } from "vitest";
import { readDbPoolMax, readPort, readPublicBaseUrl } from "../../src/config.js";

describe("readPort", () => {
  it("uses the default when PORT is unset", () => {
    expect(readPort(undefined)).toBe(3001);
  });

  // The regression this exists for: `Number("")` is 0, NOT NaN, so a NaN-only guard let a
  // set-but-empty PORT — the normal shape of a templated-but-unsupplied env var — bind an
  // OS-assigned ephemeral port while every probe still pointed at 3001.
  it("falls back for a set-but-unusable value rather than binding somewhere else", () => {
    for (const raw of ["", "   ", "0", "http", "-1", "80.5", "70000", "3001abc"]) {
      expect(readPort(raw), JSON.stringify(raw)).toBe(3001);
    }
  });

  it("reads a real port, ignoring surrounding whitespace", () => {
    expect(readPort("8080")).toBe(8080);
    expect(readPort(" 8080 ")).toBe(8080);
    expect(readPort("65535")).toBe(65535);
  });

  it("honors an explicit fallback", () => {
    expect(readPort("", 4000)).toBe(4000);
  });
});

// Bounds the pg pool for a shared database instance. Same defensive shape as readPort: an
// empty/garbage/non-positive value must fall back to the default rather than disabling the bound.
describe("readDbPoolMax", () => {
  it("uses the default when DB_POOL_MAX is unset", () => {
    expect(readDbPoolMax(undefined)).toBe(10);
  });

  it("honors a set value", () => {
    expect(readDbPoolMax("5")).toBe(5);
    expect(readDbPoolMax(" 5 ")).toBe(5);
  });

  it("falls back for a set-but-unusable value", () => {
    for (const raw of ["", "   ", "0", "-1", "http", "5.5", "5abc"]) {
      expect(readDbPoolMax(raw), JSON.stringify(raw)).toBe(10);
    }
  });

  it("honors an explicit fallback", () => {
    expect(readDbPoolMax("", 3)).toBe(3);
  });
});

describe("readPublicBaseUrl", () => {
  it("defaults to the relative `/`, which is what local development runs with", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(readPublicBaseUrl(raw), JSON.stringify(raw)).toBe("/");
    }
    expect(readPublicBaseUrl("/")).toBe("/");
    expect(readPublicBaseUrl(undefined, "https://api.ethrfps.app")).toBe("https://api.ethrfps.app");
  });

  it("accepts an absolute origin and normalizes it", () => {
    expect(readPublicBaseUrl("https://api.ethrfps.app")).toBe("https://api.ethrfps.app");
    expect(readPublicBaseUrl(" https://api.ethrfps.app ")).toBe("https://api.ethrfps.app");
  });

  // servers[0].url is joined with paths that already begin with "/", so a trailing slash would
  // publish "//v1/opportunities".
  it("strips a trailing slash, including under a base path", () => {
    expect(readPublicBaseUrl("https://api.ethrfps.app/")).toBe("https://api.ethrfps.app");
    expect(readPublicBaseUrl("https://proxy.example.org/api/")).toBe(
      "https://proxy.example.org/api",
    );
  });

  // The domain is on the HSTS preload list: a plaintext origin under it is one no browser will
  // ever use, so publishing it in the OpenAPI document would break every "Try it out" in the docs.
  it("rejects a non-https scheme on this project's own domain and its subdomains", () => {
    for (const raw of [
      "http://ethrfps.app",
      "http://api.ethrfps.app",
      "http://api-staging.ethrfps.app",
      "http://API.ETHRFPS.APP",
      "ftp://api.ethrfps.app",
    ]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/https/i);
    }
  });

  // Only this project's own domain is constrained — nothing here knows the transport in front of
  // an arbitrary host, and local development legitimately runs over plain http.
  it("leaves other hosts alone", () => {
    expect(readPublicBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(readPublicBaseUrl("http://not-ethrfps.app")).toBe("http://not-ethrfps.app");
  });

  // A bare hostname is the common mistake, and there is no safe value to fall back to: serving `/`
  // in its place hands every consumer a document that resolves against whichever host loaded it.
  it("rejects a value that is not an absolute URL", () => {
    for (const raw of ["api.ethrfps.app", "https://", "//api.ethrfps.app", "not a url"]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/PUBLIC_BASE_URL/);
    }
  });
});
