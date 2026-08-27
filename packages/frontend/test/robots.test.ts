/**
 * `robots.ts` allows the public surface and disallows the workbench ONLY on the declared canonical
 * origin, and disallows everything — never a hard-coded sitemap URL — everywhere else, including
 * staging and every Vercel preview.
 */
import robots from "@/app/robots";
import { NOINDEX_ROUTE_PREFIXES } from "@/lib/noindex-routes";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

async function mockHost(host: string | null) {
  const { headers } = await import("next/headers");
  vi.mocked(headers).mockResolvedValue({
    get: (key: string) => (key === "host" ? host : key === "x-forwarded-proto" ? "https" : null),
  } as unknown as Awaited<ReturnType<typeof headers>>);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("robots.txt", () => {
  it("allows the public surface on the canonical origin, but disallows the workbench prefixes", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const file = await robots();
    expect(file.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: [...NOINDEX_ROUTE_PREFIXES],
    });
  });

  it("points at this deployment's own sitemap on the canonical origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const file = await robots();
    expect(file.sitemap).toBe("https://ethrfps.app/sitemap.xml");
  });

  it("disallows everything when NEXT_PUBLIC_SITE_ORIGIN is unset — the normal state off production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("ethrfps.app");

    const file = await robots();
    expect(file.rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(file.sitemap).toBeUndefined();
  });

  it("disallows everything on a staging alias, even though the variable is set for production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("staging.ethrfps.app");

    const file = await robots();
    expect(file.rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(file.sitemap).toBeUndefined();
  });

  it("disallows everything on an unrecognised Vercel preview host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("the-rfp-hub-git-feature-branch.vercel.app");

    const file = await robots();
    expect(file.rules).toEqual({ userAgent: "*", disallow: "/" });
  });
});
