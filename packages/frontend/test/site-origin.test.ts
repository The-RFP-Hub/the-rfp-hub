/**
 * The two facts `sitemap.ts`, `robots.ts` and `root-metadata.ts` need: the origin this request landed
 * on, and whether it is the one origin this deployment declares itself canonical for.
 */
import {
  canonicalSiteOrigin,
  isCanonicalRequest,
  originFromHeaders,
  requestOrigin,
} from "@/lib/site-origin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// The suite must not inherit whatever platform variables the machine running it happens to export.
beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("originFromHeaders", () => {
  it("combines the forwarded protocol with the host", () => {
    expect(originFromHeaders("rfpsear.ch", "https")).toBe("https://rfpsear.ch");
  });

  it("defaults to https when no protocol was forwarded", () => {
    // The normal shape behind a platform's edge: it terminates TLS and forwards over plain HTTP
    // internally, so an ABSENT header means "https", never "whatever this internal hop used".
    expect(originFromHeaders("rfpsear.ch", null)).toBe("https://rfpsear.ch");
  });

  it("takes the first value when the header carries a chain of proxies", () => {
    expect(originFromHeaders("rfpsear.ch", "https, http")).toBe("https://rfpsear.ch");
  });

  it("resolves nothing without a host — never guesses one", () => {
    expect(originFromHeaders(null, "https")).toBeNull();
  });

  it("prefers x-forwarded-host, which is the address the browser actually used", () => {
    // The shape behind a CDN or load balancer that rewrites Host to an internal name: without this
    // preference, such a deployment could never match its own canonical origin.
    expect(originFromHeaders("frontend.internal", "https", "rfpsear.ch")).toBe(
      "https://rfpsear.ch",
    );
  });

  it("takes the first forwarded host when the header carries a chain of proxies", () => {
    expect(originFromHeaders("frontend.internal", "https", "rfpsear.ch, edge.internal")).toBe(
      "https://rfpsear.ch",
    );
  });

  it("falls back to Host when nothing forwarded a host", () => {
    expect(originFromHeaders("rfpsear.ch", "https", null)).toBe("https://rfpsear.ch");
    expect(originFromHeaders("rfpsear.ch", "https", "")).toBe("https://rfpsear.ch");
  });
});

describe("requestOrigin", () => {
  it("reads the host and forwarded-proto headers off the actual request", async () => {
    const { headers } = await import("next/headers");
    const get = vi.fn((key: string) =>
      key === "host" ? "staging.rfpsear.ch" : key === "x-forwarded-proto" ? "https" : null,
    );
    vi.mocked(headers).mockResolvedValue({ get } as unknown as Awaited<ReturnType<typeof headers>>);

    await expect(requestOrigin()).resolves.toBe("https://staging.rfpsear.ch");
  });
});

describe("canonicalSiteOrigin", () => {
  it("is undefined when the operator has declared nothing — the normal state off production", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    expect(canonicalSiteOrigin()).toBeUndefined();
  });

  it("normalizes through URL().origin, dropping a trailing slash or stray path", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://rfpsear.ch/");
    expect(canonicalSiteOrigin()).toBe("https://rfpsear.ch");
  });

  it("is undefined for an unparsable value — never throws, never guesses", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "not a url");
    expect(canonicalSiteOrigin()).toBeUndefined();
  });

  it("derives the origin from Vercel's production environment when nothing was declared", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rfpsear.ch");
    expect(canonicalSiteOrigin()).toBe("https://rfpsear.ch");
  });

  it("is undefined on a Vercel preview, which is what keeps every preview out of the index", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rfpsear.ch");
    expect(canonicalSiteOrigin()).toBeUndefined();
  });

  it("is undefined off Vercel with nothing declared — an unconfigured copy stays unindexed", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    expect(canonicalSiteOrigin()).toBeUndefined();
  });

  it("lets an explicit value win over Vercel's production domain", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://mirror.example.org");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rfpsear.ch");
    expect(canonicalSiteOrigin()).toBe("https://mirror.example.org");
  });

  it("is undefined when VERCEL_ENV says production but no production domain is named", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(canonicalSiteOrigin()).toBeUndefined();
  });
});

describe("isCanonicalRequest", () => {
  function mockHost(host: string | null, forwardedHost: string | null = null) {
    return import("next/headers").then(({ headers }) => {
      vi.mocked(headers).mockResolvedValue({
        get: (key: string) =>
          key === "host"
            ? host
            : key === "x-forwarded-host"
              ? forwardedHost
              : key === "x-forwarded-proto"
                ? "https"
                : null,
      } as unknown as Awaited<ReturnType<typeof headers>>);
    });
  }

  it("is false when NEXT_PUBLIC_SITE_ORIGIN is unset, whatever the request's own origin is", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(false);
  });

  it("is true when the request origin matches the declared canonical origin exactly", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://rfpsear.ch");
    await mockHost("rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(true);
  });

  it("is false for a staging alias or a preview, even with the variable set on production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://rfpsear.ch");
    await mockHost("staging.rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(false);
  });

  it("is true behind a proxy that rewrote Host, because the forwarded host is the real one", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://rfpsear.ch");
    await mockHost("frontend.internal:8080", "rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(true);
  });

  it("is false when the proxy forwards some other host, whatever Host says", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://rfpsear.ch");
    await mockHost("rfpsear.ch", "staging.rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(false);
  });

  it("is false for a malformed NEXT_PUBLIC_SITE_ORIGIN — a typo costs indexing, never privacy", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "rfpsear.ch");
    await mockHost("rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(false);
  });

  it("is true on Vercel production with nothing declared, once the request lands on that host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rfpsear.ch");
    await mockHost("rfpsear.ch");

    await expect(isCanonicalRequest()).resolves.toBe(true);
  });

  it("is false on a Vercel preview with nothing declared", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "rfpsear.ch");
    await mockHost("feature-branch.vercel.app");

    await expect(isCanonicalRequest()).resolves.toBe(false);
  });
});
