/**
 * Pure unit test for the seed's >=100 contract guard. No DB/network — imports only the helper.
 */
import { describe, expect, it } from "vitest";
import { assertSeedContract } from "../../scripts/seed.js";

describe("assertSeedContract", () => {
  it("throws below the default floor of 100", () => {
    expect(() => assertSeedContract(99)).toThrow();
    expect(() => assertSeedContract(0)).toThrow(/seed contract/);
  });

  it("passes at or above the floor", () => {
    expect(() => assertSeedContract(100)).not.toThrow();
    expect(() => assertSeedContract(120)).not.toThrow();
  });

  it("honors a custom min", () => {
    expect(() => assertSeedContract(5, 5)).not.toThrow();
    expect(() => assertSeedContract(4, 5)).toThrow();
  });
});
