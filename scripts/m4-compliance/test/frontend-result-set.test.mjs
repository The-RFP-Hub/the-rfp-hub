/**
 * `expectResultSetChanged` — an independent acceptance audit's finding: `JSON.stringify(a) !==
 * JSON.stringify(b)` alone is satisfied just as well by "0 items vs 20 items" as by "20 different
 * items", so an EMPTY filtered result was passing as proof a filter works, when it is equally
 * consistent with a broken filter (or param) matching nothing. This locks in that an empty result
 * is always a named FAIL, never accepted as "changed".
 */
import { describe, expect, it } from "vitest";
import { expectResultSetChanged } from "../checks/frontend.mjs";

/** A fake criterion recording every call, in the same shape `report.criterion()` returns. */
function fakeCriterion() {
  const calls = [];
  return {
    calls,
    expect(condition, name, okDetail, failDetail) {
      calls.push({
        method: condition ? "pass" : "fail",
        name,
        detail: condition ? okDetail : failDetail,
      });
    },
    fail(name, detail) {
      calls.push({ method: "fail", name, detail });
    },
  };
}

describe("expectResultSetChanged", () => {
  it("fails, naming the emptiness, when the new set is empty — never treated as proof of change", () => {
    const c = fakeCriterion();
    expectResultSetChanged(
      c,
      "type=grant filter changes the result set",
      [],
      ["a", "b"],
      "the filter may be broken.",
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].method).toBe("fail");
    expect(c.calls[0].name).toBe("type=grant filter changes the result set");
    expect(c.calls[0].detail).toContain("ZERO items");
    expect(c.calls[0].detail).toContain("the filter may be broken.");
  });

  it("fails when the new set is empty even if the baseline was ALSO empty", () => {
    // Two empties are trivially "the same" by JSON.stringify, but the empty-set rule fires first
    // and independently — this must never read as "unchanged, but that's fine because both are
    // consistently empty".
    const c = fakeCriterion();
    expectResultSetChanged(c, "name", [], [], "hint");
    expect(c.calls[0].method).toBe("fail");
    expect(c.calls[0].detail).toContain("ZERO items");
  });

  it("passes when the new set is non-empty and different from the baseline", () => {
    const c = fakeCriterion();
    expectResultSetChanged(c, "name", ["x", "y"], ["a", "b", "c"], "hint");
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].method).toBe("pass");
  });

  it("fails when the new set is non-empty but identical to the baseline", () => {
    const c = fakeCriterion();
    expectResultSetChanged(c, "name", ["a", "b"], ["a", "b"], "hint");
    expect(c.calls[0].method).toBe("fail");
    expect(c.calls[0].detail).toContain("the same 2 item(s)");
  });

  it("treats a reordering of the same ids as a change (order matters — it's page order)", () => {
    const c = fakeCriterion();
    expectResultSetChanged(c, "name", ["b", "a"], ["a", "b"], "hint");
    expect(c.calls[0].method).toBe("pass");
  });
});
