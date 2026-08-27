/**
 * `sitemap.ts` and `robots.ts` need one absolute origin, and it must be THIS DEPLOYMENT'S — not
 * `NEXT_PUBLIC_API_URL` (that names the API) and not a literal (that would make every self-hosted
 * fork's sitemap describe production's address). These are the pure rules for deriving it from the
 * request headers a reverse proxy or platform edge actually sets.
 */
import { originFromHeaders, requestOrigin } from "@/lib/site-origin";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

describe("originFromHeaders", () => {
  it("combines the forwarded protocol with the host", () => {
    expect(originFromHeaders("ethrfps.app", "https")).toBe("https://ethrfps.app");
  });

  it("defaults to https when no protocol was forwarded", () => {
    // The normal shape behind a platform's edge: it terminates TLS and forwards over plain HTTP
    // internally, so an ABSENT header means "https", never "whatever this internal hop used".
    expect(originFromHeaders("ethrfps.app", null)).toBe("https://ethrfps.app");
  });

  it("takes the first value when the header carries a chain of proxies", () => {
    expect(originFromHeaders("ethrfps.app", "https, http")).toBe("https://ethrfps.app");
  });

  it("resolves nothing without a host — never guesses one", () => {
    expect(originFromHeaders(null, "https")).toBeNull();
  });
});

describe("requestOrigin", () => {
  it("reads the host and forwarded-proto headers off the actual request", async () => {
    const { headers } = await import("next/headers");
    const get = vi.fn((key: string) =>
      key === "host" ? "staging.ethrfps.app" : key === "x-forwarded-proto" ? "https" : null,
    );
    vi.mocked(headers).mockResolvedValue({ get } as unknown as Awaited<ReturnType<typeof headers>>);

    await expect(requestOrigin()).resolves.toBe("https://staging.ethrfps.app");
  });
});
