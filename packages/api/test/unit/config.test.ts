/**
 * PURE config tests. `readPort` is the only branchy thing in src/config.ts, and it is the one the
 * container contract depends on: the image EXPOSEs 3001 and every probe points at it.
 */
import { describe, expect, it } from "vitest";
import { readPort } from "../../src/config.js";

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
