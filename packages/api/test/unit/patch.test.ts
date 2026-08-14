/**
 * THE AUDIT PATCH.
 *
 * Two audiences, one computation: the public trail shows field NAMES, the submitter/publisher and
 * T3+ see the values. Deriving both from `diffFields` is what stops the public view from ever
 * being a different — or staler — answer than the private one.
 *
 * The comparison cases below are the ones that make an audit trail useless when they are wrong: a
 * timestamp that compares by reference marks every field as changed on every write, and a JSONB
 * object whose keys came back in a different order looks like an edit nobody made.
 */
import { describe, expect, it } from "vitest";
import {
  changedFields,
  deepEqual,
  diffFields,
  isEmptyPatch,
} from "../../src/modules/shared/patch.js";

describe("deepEqual", () => {
  it("compares dates by instant, not by reference", () => {
    expect(deepEqual(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"))).toBe(
      true,
    );
    // A driver hands back a Date; the submitted document carried a string. Same instant.
    expect(deepEqual(new Date("2026-03-01T00:00:00Z"), "2026-03-01T00:00:00.000Z")).toBe(true);
    expect(deepEqual(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-02T00:00:00Z"))).toBe(
      false,
    );
  });

  it("compares objects by content, not key order", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("keeps array order significant — it is the sequence in the Standard", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("does not confuse null, undefined and falsy scalars", () => {
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, 0)).toBe(false);
    expect(deepEqual("", null)).toBe(false);
  });
});

describe("diffFields", () => {
  it("records before and after for each changed field only", () => {
    const patch = diffFields(
      { title: "Old", status: "open", budget: 1000 },
      { title: "New", status: "open", budget: 1000 },
    );
    expect(patch).toEqual({ title: { before: "Old", after: "New" } });
  });

  // Otherwise every audit row is dominated by a timestamp that changed because the row was
  // written, which is the one thing an audit row already tells you.
  it("ignores the server-maintained timestamps", () => {
    const patch = diffFields(
      { title: "A", updatedAt: new Date("2026-01-01"), createdAt: new Date("2025-01-01") },
      { title: "A", updatedAt: new Date("2026-06-01"), createdAt: new Date("2025-01-01") },
    );
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it("honours extra ignores", () => {
    const patch = diffFields({ a: 1, b: 1 }, { a: 2, b: 2 }, { ignore: ["b"] });
    expect(changedFields(patch)).toEqual(["a"]);
  });

  it("treats a create as every field being new", () => {
    const patch = diffFields({}, { title: "New", status: "open" });
    expect(patch.title).toEqual({ before: undefined, after: "New" });
    expect(changedFields(patch)).toEqual(["status", "title"]);
  });

  it("records a removal as after: undefined", () => {
    const patch = diffFields({ summary: "gone" }, {});
    expect(patch.summary).toEqual({ before: "gone", after: undefined });
  });
});

describe("changedFields", () => {
  // Sorted so the same change reads the same way every time it is rendered.
  it("is the sorted key list, which is exactly what the public trail exposes", () => {
    const patch = diffFields({}, { zeta: 1, alpha: 2, mid: 3 });
    expect(changedFields(patch)).toEqual(["alpha", "mid", "zeta"]);
    // and it carries no values
    expect(JSON.stringify(changedFields(patch))).not.toContain("1");
  });
});
