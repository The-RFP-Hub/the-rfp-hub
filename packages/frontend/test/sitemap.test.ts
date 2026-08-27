/**
 * `sitemap.ts` covers exactly the static public surface, and none of it is fetched — see the file's
 * own comment for why the opportunities themselves are not enumerated here.
 */
import sitemap from "@/app/sitemap";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) =>
      key === "host" ? "ethrfps.app" : key === "x-forwarded-proto" ? "https" : null,
  })),
}));

describe("the public sitemap", () => {
  it("lists exactly the five static public routes, as absolute URLs on this deployment's own origin", async () => {
    const entries = await sitemap();

    expect(entries.map((entry) => entry.url)).toEqual([
      "https://ethrfps.app/",
      "https://ethrfps.app/how-it-works",
      "https://ethrfps.app/publishers",
      "https://ethrfps.app/privacy",
      "https://ethrfps.app/terms",
    ]);
  });

  it("carries no opportunity, organization or listing route", async () => {
    const entries = await sitemap();
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/opportunities\/|\/organizations\/|\/listings/);
    }
  });
});
