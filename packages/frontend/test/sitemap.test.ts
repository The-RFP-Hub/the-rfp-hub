/**
 * `sitemap.ts` covers the static public surface plus every listed opportunity, publishes only on
 * the declared canonical origin — the load-bearing rule — and survives an API it cannot read.
 */
import sitemap from "@/app/sitemap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const STATIC_URLS = [
  "https://ethrfps.app/",
  "https://ethrfps.app/how-it-works",
  "https://ethrfps.app/publishers",
  "https://ethrfps.app/privacy",
  "https://ethrfps.app/terms",
];

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

interface Row {
  id: string;
  updatedAt?: string;
}

function stubDirectory(rows: Row[], pageSize = 100): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? String(pageSize));
    const items = rows.slice((page - 1) * limit, page * limit);
    return new Response(
      JSON.stringify({
        items,
        page,
        limit,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / limit)),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

// The suite must not inherit whatever platform variables the machine running it happens to export.
beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
  stubDirectory([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the public sitemap", () => {
  it("lists the five static public routes, then every listed opportunity", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    stubDirectory([{ id: "curated:0x-bug-bounty" }, { id: "fundingmap:1496" }]);

    const entries = await sitemap();

    expect(entries.map((entry) => entry.url)).toEqual([
      ...STATIC_URLS,
      "https://ethrfps.app/opportunities/curated%3A0x-bug-bounty",
      "https://ethrfps.app/opportunities/fundingmap%3A1496",
    ]);
  });

  it("pages the list route 100 at a time and revalidates it hourly", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    const rows = Array.from({ length: 160 }, (_, index) => ({ id: `entry-${index}` }));
    const fetchImpl = stubDirectory(rows);

    const entries = await sitemap();

    expect(entries).toHaveLength(STATIC_URLS.length + 160);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.example.test/v1/opportunities?page=1&limit=100",
      "https://api.example.test/v1/opportunities?page=2&limit=100",
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ next: { revalidate: 3600 } });
  });

  it("stops well below the sitemap limit rather than enumerating an unbounded directory", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    stubDirectory(Array.from({ length: 6_000 }, (_, index) => ({ id: `entry-${index}` })));

    const entries = await sitemap();

    expect(entries).toHaveLength(STATIC_URLS.length + 5_000);
  });

  it("falls back to the static routes when the API cannot be reached", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(sitemap()).resolves.toEqual(STATIC_URLS.map((url) => ({ url })));
  });

  it("falls back to the static routes when the API answers with something that is not a list", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: "all of them" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(sitemap()).resolves.toEqual(STATIC_URLS.map((url) => ({ url })));
  });

  it("falls back to the static routes when this deployment was built with no API to read", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    await mockHost("ethrfps.app");

    await expect(sitemap()).resolves.toEqual(STATIC_URLS.map((url) => ({ url })));
  });

  it("never stamps a fabricated lastModified", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    stubDirectory([{ id: "dated", updatedAt: "2026-08-01T00:00:00Z" }, { id: "undated" }]);

    const entries = await sitemap();
    const byUrl = new Map(entries.map((entry) => [entry.url, entry.lastModified]));

    for (const url of STATIC_URLS) expect(byUrl.get(url)).toBeUndefined();
    expect(byUrl.get("https://ethrfps.app/opportunities/dated")).toBe("2026-08-01T00:00:00Z");
    expect(byUrl.get("https://ethrfps.app/opportunities/undated")).toBeUndefined();
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

  it("carries no organization, listing or workbench route", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");
    stubDirectory([{ id: "curated:0x-bug-bounty" }]);

    const entries = await sitemap();
    for (const entry of entries) {
      expect(entry.url).not.toMatch(
        /\/organizations\/|\/organisations\/|\/listings|\/dashboard|\/review|\/admin/,
      );
    }
  });
});
