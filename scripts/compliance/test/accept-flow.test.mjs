/**
 * The acceptance flow's invariants, without a deployment: a fixture id unique per PROCESS (two runs
 * in the same minute shared one, so the second "found" the first's entry) and an owner snapshot
 * that sees past the first page (a submitter with 100+ entries never found its own fixture).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../client.mjs", () => ({ callJson: vi.fn() }));

const { callJson } = await import("../client.mjs");
const { fixtureDocument, ownedIds, runToken } = await import("../accept/flow.mjs");

describe("runToken", () => {
  it("differs between calls made in the same minute", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const tokens = new Set(Array.from({ length: 50 }, () => runToken(now)));
    expect(tokens.size).toBe(50);
  });

  it("produces a fixture id in the compliance namespace", () => {
    const id = fixtureDocument(runToken()).id;
    expect(id.startsWith("compliance:compliance-")).toBe(true);
    expect(id).toMatch(/^compliance:compliance-[0-9a-z-]+$/);
  });
});

describe("ownedIds", () => {
  it("follows pagination past the first 100 entries", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `acme:item-${i}` }));
    callJson.mockImplementation(async (_ctx, path) => {
      const page = Number(new URL(path, "http://x").searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        json: { items: all.slice((page - 1) * 100, page * 100), total: all.length },
      };
    });
    const ids = await ownedIds({ apiKey: "rfph_x" });
    expect(ids).toHaveLength(250);
    expect(ids.at(-1)).toBe("acme:item-249");
  });

  it("throws rather than reporting an empty snapshot when the listing errors", async () => {
    callJson.mockResolvedValue({ ok: true, status: 500 });
    await expect(ownedIds({ apiKey: "rfph_x" })).rejects.toThrow(/answered 500/);
  });
});
