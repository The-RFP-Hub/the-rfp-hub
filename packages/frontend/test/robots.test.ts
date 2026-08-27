/**
 * `robots.ts` allows everything — see the file's own comment for why there is nothing here worth
 * carving an exception for — and points at this deployment's own sitemap, never a hard-coded one.
 */
import robots from "@/app/robots";
import { describe, expect, it, vi } from "vitest";

const { hostHeader } = vi.hoisted(() => ({
  hostHeader: { current: "ethrfps.app" as string | null },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) =>
      key === "host" ? hostHeader.current : key === "x-forwarded-proto" ? "https" : null,
  })),
}));

describe("robots.txt", () => {
  it("allows every crawler everything", async () => {
    const file = await robots();
    expect(file.rules).toEqual({ userAgent: "*", allow: "/" });
  });

  it("points at this deployment's own sitemap, not a literal address", async () => {
    hostHeader.current = "staging.ethrfps.app";
    const file = await robots();
    expect(file.sitemap).toBe("https://staging.ethrfps.app/sitemap.xml");
  });

  it("omits the sitemap reference rather than emit an address a crawler cannot resolve", async () => {
    hostHeader.current = null;
    const file = await robots();
    expect(file.sitemap).toBeUndefined();
  });
});
