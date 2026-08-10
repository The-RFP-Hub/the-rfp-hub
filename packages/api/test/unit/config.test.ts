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
    expect(readPublicBaseUrl(undefined, "https://api.example.org")).toBe("https://api.example.org");
  });

  it("accepts an absolute origin and normalizes it", () => {
    expect(readPublicBaseUrl("https://api.example.org")).toBe("https://api.example.org");
    expect(readPublicBaseUrl(" https://api.example.org ")).toBe("https://api.example.org");
  });

  // servers[0].url is joined with paths that already begin with "/", so a trailing slash would
  // publish "//v1/opportunities".
  it("strips a trailing slash, including under a base path", () => {
    expect(readPublicBaseUrl("https://api.example.org/")).toBe("https://api.example.org");
    expect(readPublicBaseUrl("https://proxy.example.org/api/")).toBe(
      "https://proxy.example.org/api",
    );
    expect(readPublicBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  // The rule is about the transport, not about any particular domain: this value is published as
  // servers[0].url, so a plaintext remote origin tells EVERY client to speak plaintext. Any host
  // that is not loopback must therefore be https, whoever owns it.
  it("rejects a non-https scheme on any host that is not loopback", () => {
    for (const raw of [
      "http://example.org",
      "http://api.example.org",
      "http://api-staging.example.org",
      "http://API.EXAMPLE.ORG",
      "ftp://api.example.org",
      "http://anything-else.example.com",
      "http://192.168.1.10:3001",
      "http://10.0.0.5",
      "http://api.local",
      "http://0.0.0.0:3001",
    ]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/https/i);
    }
  });

  // Loopback traffic never leaves the machine, so there is no segment on which the plaintext could
  // be observed — and local development legitimately runs over plain http.
  it("accepts a plaintext scheme on a loopback host", () => {
    expect(readPublicBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(readPublicBaseUrl("http://LOCALHOST:3001")).toBe("http://localhost:3001");
    // RFC 6761 §6.3 reserves the whole *.localhost subtree to loopback.
    expect(readPublicBaseUrl("http://api.localhost:3001")).toBe("http://api.localhost:3001");
    // The whole 127.0.0.0/8 block is loopback (RFC 1122 §3.2.1.3), not just 127.0.0.1.
    expect(readPublicBaseUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    expect(readPublicBaseUrl("http://127.0.0.2:3001")).toBe("http://127.0.0.2:3001");
    // IPv6 loopback — new URL() reports the hostname bracketed.
    expect(readPublicBaseUrl("http://[::1]:3001")).toBe("http://[::1]:3001");
  });

  it("accepts https on any host, loopback or not", () => {
    expect(readPublicBaseUrl("https://api.example.org")).toBe("https://api.example.org");
    expect(readPublicBaseUrl("https://anything-else.example.com")).toBe(
      "https://anything-else.example.com",
    );
    expect(readPublicBaseUrl("https://localhost:3001")).toBe("https://localhost:3001");
    expect(readPublicBaseUrl("https://127.0.0.1:3001")).toBe("https://127.0.0.1:3001");
  });

  // A bare hostname is the common mistake, and there is no safe value to fall back to: serving `/`
  // in its place hands every consumer a document that resolves against whichever host loaded it.
  it("rejects a value that is not an absolute URL", () => {
    for (const raw of ["api.example.org", "https://", "//api.example.org", "not a url"]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/PUBLIC_BASE_URL/);
    }
  });
});
