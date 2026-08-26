import { describe, expect, it, vi } from "vitest";
import type { DB, DbLike } from "../../src/db/client.js";
import type { OrganizationRow } from "../../src/db/schema.js";
import { type Repositories, repositories } from "../../src/modules/repositories/index.js";
import { DedupeService } from "../../src/modules/services/dedupe/dedupe.service.js";
import { ReviewService } from "../../src/modules/services/review/review.service.js";

function fakeExec(rows: Record<string, unknown>[]): DbLike {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    })),
  } as unknown as DbLike;
}

function rejectingPool(): DB {
  return {
    select: vi.fn(() => {
      throw new Error("the helper escaped to the pool-backed client");
    }),
  } as unknown as DB;
}

describe("transaction-bound service helpers", () => {
  it("counts organization members with the executor passed to summarize", async () => {
    const service = new ReviewService(rejectingPool());
    const exec = fakeExec([{ value: 3 }]);
    const summarize = (
      service as unknown as {
        summarize(repos: Repositories, row: OrganizationRow): Promise<{ memberCount: number }>;
      }
    ).summarize.bind(service);

    const summary = await summarize(repositories(exec), {
      id: 7,
      slug: "acme",
      name: "Acme",
      verified: true,
      verifiedAt: null,
      website: null,
      ecosystems: [],
    } as unknown as OrganizationRow);

    expect(summary.memberCount).toBe(3);
    expect(exec.select).toHaveBeenCalledOnce();
  });

  it("loads survivor public ids with the executor passed to survivorIds", async () => {
    const service = new DedupeService(rejectingPool());
    const exec = fakeExec([
      { id: 11, publicId: "acme:survivor" },
      { id: 12, publicId: "acme:other" },
    ]);
    const survivorIds = (
      service as unknown as {
        survivorIds(exec: DbLike, ids: (number | null)[]): Promise<Map<number, string>>;
      }
    ).survivorIds.bind(service);

    const survivors = await survivorIds(exec, [11, null, 12, 11]);

    expect(survivors).toEqual(
      new Map([
        [11, "acme:survivor"],
        [12, "acme:other"],
      ]),
    );
    expect(exec.select).toHaveBeenCalledOnce();
  });
});
