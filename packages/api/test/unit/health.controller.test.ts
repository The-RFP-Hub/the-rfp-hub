import { describe, expect, it } from "vitest";
import type { DB } from "../../src/db/client.js";
import { HealthController } from "../../src/modules/controller/Health.controller.js";

describe("HealthController.ping", () => {
  it("returns true when the database answers", async () => {
    const ctl = new HealthController({ execute: async () => ({}) } as unknown as DB);
    expect(await ctl.ping()).toBe(true);
  });

  it("returns false when the query throws", async () => {
    const ctl = new HealthController({
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as DB);
    expect(await ctl.ping()).toBe(false);
  });
});
