/**
 * `sitemap.ts` covers the static public surface and — the load-bearing rule — publishes it only on
 * the declared canonical origin. Staging and every preview must get an empty sitemap.
 */
import sitemap from "@/app/sitemap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

async function mockHost(host: string | null, forwardedHost: string | null = null) {
  const { headers } = await import("next/headers");
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
}

// The suite must not inherit whatever platform variables the machine running it happens to export.
beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the public sitemap", () => {
  it("lists exactly the five static public routes when the request matches the canonical origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const entries = await sitemap();

    expect(entries.map((entry) => entry.url)).toEqual([
      "https://ethrfps.app/",
      "https://ethrfps.app/how-it-works",
      "https://ethrfps.app/publishers",
      "https://ethrfps.app/privacy",
      "https://ethrfps.app/terms",
    ]);
  });

  it("never stamps a fabricated lastModified", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const entries = await sitemap();
    for (const entry of entries) expect(entry.lastModified).toBeUndefined();
  });

  it("is empty when NEXT_PUBLIC_SITE_ORIGIN is unset — the normal state off production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("ethrfps.app");

    await expect(sitemap()).resolves.toEqual([]);
  });

  it("is empty on a staging alias, even though the variable is set for production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("staging.ethrfps.app");

    await expect(sitemap()).resolves.toEqual([]);
  });

  it("is empty when NEXT_PUBLIC_SITE_ORIGIN is malformed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "ethrfps.app");
    await mockHost("ethrfps.app");

    await expect(sitemap()).resolves.toEqual([]);
  });

  it("publishes for the forwarded host when a proxy rewrote Host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("frontend.internal:8080", "ethrfps.app");

    const entries = await sitemap();
    expect(entries.map((entry) => entry.url)).toContain("https://ethrfps.app/publishers");
  });

  it("publishes on Vercel production with nothing declared", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ethrfps.app");
    await mockHost("ethrfps.app");

    const entries = await sitemap();
    expect(entries.map((entry) => entry.url)).toContain("https://ethrfps.app/");
  });

  it("is empty on a Vercel preview with nothing declared", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ethrfps.app");
    await mockHost("the-rfp-hub-git-feature-branch.vercel.app");

    await expect(sitemap()).resolves.toEqual([]);
  });

  it("is empty off Vercel with nothing declared", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("copy.example.org");

    await expect(sitemap()).resolves.toEqual([]);
  });

  it("publishes for the explicit variable, not Vercel's production domain, when both are present", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://mirror.example.org");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ethrfps.app");
    await mockHost("mirror.example.org");

    const entries = await sitemap();
    expect(entries.map((entry) => entry.url)).toContain("https://mirror.example.org/");
  });

  it("carries no opportunity, organization or listing route", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const entries = await sitemap();
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/opportunities\/|\/organizations\/|\/listings/);
    }
  });
});
