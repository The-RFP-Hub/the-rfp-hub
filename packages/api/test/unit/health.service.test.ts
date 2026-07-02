import { describe, expect, it } from "vitest";
import type { DB } from "../../src/db/client.js";
import { HealthService } from "../../src/modules/services/health/health.service.js";

describe("HealthService.ping", () => {
  it("returns true when the database answers", async () => {
    const service = new HealthService({ execute: async () => ({}) } as unknown as DB);
    expect(await service.ping()).toBe(true);
  });

  it("returns false when the query throws", async () => {
    const service = new HealthService({
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as DB);
    expect(await service.ping()).toBe(false);
  });
});
