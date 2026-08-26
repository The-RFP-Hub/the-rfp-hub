/**
 * The reopen state machine without DATABASE_URL.
 *
 * The end-to-end coverage is intentionally DB-gated, but these assertions keep the terminal and
 * idempotent rules live in every unit run rather than letting a skipped integration suite hide a
 * transition regression.
 */
import { describe, expect, it } from "vitest";
import { duplicateReopenTransition } from "../../src/modules/services/dedupe/duplicate-reopen.js";

describe("duplicate reopen transition", () => {
  it("changes dismissed to suspected and treats suspected as an idempotent no-op", () => {
    expect(duplicateReopenTransition("dismissed")).toBe("reopen");
    expect(duplicateReopenTransition("suspected")).toBe("unchanged");
  });

  it("keeps merged terminal with the existing conflict vocabulary", () => {
    expect(() => duplicateReopenTransition("merged")).toThrowError(
      expect.objectContaining({ status: 409, code: "already_merged" }),
    );
  });

  it("leaves confirmed pairs on the existing duplicate decision path", () => {
    expect(() => duplicateReopenTransition("confirmed")).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "duplicate_not_dismissed",
        message: expect.stringContaining("confirmed, not dismissed"),
      }),
    );
  });
});
