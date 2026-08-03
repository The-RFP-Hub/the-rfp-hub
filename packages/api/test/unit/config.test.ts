/**
 * PURE config tests. `readPort` is the only branchy thing in src/config.ts, and it is the one the
 * container contract depends on: the image EXPOSEs 3001 and every probe points at it.
 */
import { describe, expect, it } from "vitest";
import { readDbPoolMax, readPort } from "../../src/config.js";

describe("readPort", () => {
  it("uses the default when PORT is unset", () => {
    expect(readPort(undefined)).toBe(3001);
  });

  // The regression this exists for: `Number("")` is 0, NOT NaN, so a NaN-only guard let a
  // set-but-empty PORT — a templated-but-unsupplied compose/ConfigMap value — bind an
  // OS-assigned ephemeral port while the image still published 3001.
  it("falls back for a set-but-unusable value rather than binding somewhere else", () => {
    for (const raw of ["", "   ", "0", "http", "-1", "80.5", "70000", "3001abc"]) {
      expect(readPort(raw), JSON.stringify(raw)).toBe(3001);
    }
  });

  it("reads a real port, ignoring surrounding whitespace", () => {
    expect(readPort("8080")).toBe(8080);
    expect(readPort(" 8080 ")).toBe(8080);
    expect(readPort("65535")).toBe(65535);
  });

  it("honors an explicit fallback", () => {
    expect(readPort("", 4000)).toBe(4000);
  });
});

// Bounds the pg pool for shared database instances. Same defensive shape as readPort: an
// empty/garbage/non-positive value must fall back to the default rather than disabling the bound.
describe("readDbPoolMax", () => {
  it("uses the default when DB_POOL_MAX is unset", () => {
    expect(readDbPoolMax(undefined)).toBe(10);
  });

  it("honors a set value", () => {
    expect(readDbPoolMax("5")).toBe(5);
    expect(readDbPoolMax(" 5 ")).toBe(5);
  });

  it("falls back for a set-but-unusable value", () => {
    for (const raw of ["", "   ", "0", "-1", "http", "5.5", "5abc"]) {
      expect(readDbPoolMax(raw), JSON.stringify(raw)).toBe(10);
    }
  });

  it("honors an explicit fallback", () => {
    expect(readDbPoolMax("", 3)).toBe(3);
  });
});
