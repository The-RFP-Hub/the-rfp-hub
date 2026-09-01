/**
 * The root layout's `robots` field is no longer a build-time constant — it depends on whether THIS
 * request landed on the declared canonical origin (`src/lib/site-origin.ts`). Staging and every
 * Vercel preview must render `noindex`; only the one origin named by `NEXT_PUBLIC_SITE_ORIGIN`
 * renders `index: true`.
 */
import { generateMetadata } from "@/lib/root-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the root layout's robots metadata", () => {
  it("indexes only the request that matches the declared canonical origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("stays noindex when NEXT_PUBLIC_SITE_ORIGIN is unset — the normal state off production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("stays noindex on a staging alias, even though the variable is set for production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("staging.ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("stays noindex when NEXT_PUBLIC_SITE_ORIGIN is malformed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "ethrfps.app");
    await mockHost("ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("indexes behind a proxy that rewrote Host, on the forwarded host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://ethrfps.app");
    await mockHost("frontend.internal:8080", "ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("keeps the title and description regardless of indexing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    await mockHost("ethrfps.app");

    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ default: "Directory | RFP Hub", template: "%s | RFP Hub" });
    expect(typeof metadata.description).toBe("string");
  });
});
