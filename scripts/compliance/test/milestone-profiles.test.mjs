/**
 * The registry, and the two selection rules that decide whether a scoped run means anything.
 *
 * A milestone profile that names a criterion the registry does not hold produces a run that reports
 * on fewer criteria than the milestone has, silently. A `--only` that drops a criterion's hard
 * prerequisite produces a criterion that can only report it had nothing to look at, which reads as
 * a finding about the deployment and is not one. Both are checked here rather than discovered on a
 * deployment.
 */
import { describe, expect, it } from "vitest";
import {
  READ_CRITERIA,
  READ_MILESTONES,
  WRITE_CRITERIA,
  WRITE_MILESTONES,
  contractIds,
  criterionKeys,
  selectCriteria,
  selectionRefusals,
} from "../criteria.mjs";

const keys = (selection) => selection.criteria.map((c) => c.meta.key);

describe("the registries", () => {
  it("every criterion carries a key, a run() and a requires list", () => {
    for (const criterion of [...READ_CRITERIA, ...WRITE_CRITERIA]) {
      expect(typeof criterion.meta.key).toBe("string");
      expect(typeof criterion.run).toBe("function");
      expect(Array.isArray(criterion.meta.requires)).toBe(true);
    }
  });

  it("no criterion is in both registries: a read tool must hold no code path that writes", () => {
    const read = new Set(criterionKeys(READ_CRITERIA));
    for (const key of criterionKeys(WRITE_CRITERIA)) expect(read.has(key)).toBe(false);
  });

  it("every key a milestone profile names is registered", () => {
    for (const [milestone, profile] of Object.entries(READ_MILESTONES)) {
      for (const key of profile) {
        expect(criterionKeys(READ_CRITERIA), `${milestone} → ${key}`).toContain(key);
      }
    }
    for (const [milestone, profile] of Object.entries(WRITE_MILESTONES)) {
      for (const key of profile) {
        expect(criterionKeys(WRITE_CRITERIA), `${milestone} → ${key}`).toContain(key);
      }
    }
  });

  it("contract ids are unique inside a milestone, and teardown maps to null", () => {
    const m2 = contractIds(READ_CRITERIA, "m2");
    expect(Object.values(m2)).toEqual(["M2-1", "M2-2", "M2-3", "M2-4"]);

    const m3 = contractIds(WRITE_CRITERIA, "m3");
    const mapped = Object.values(m3).filter((id) => id !== null);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(m3.teardown).toBeNull();
  });

  it("teardown is not selectable — a write run appends it, always", () => {
    expect(criterionKeys(WRITE_CRITERIA)).not.toContain("teardown");
    expect(keys(selectCriteria(WRITE_CRITERIA))).not.toContain("teardown");
  });
});

describe("--only and --skip", () => {
  it("--only dataset runs dataset alone: openapi is a soft requirement, not an auto-inclusion", () => {
    const selection = selectCriteria(READ_CRITERIA, { only: new Set(["dataset"]) });
    expect(keys(selection)).toEqual(["dataset"]);
    expect(selection.autoIncluded).toEqual([]);
  });

  it("--only audit pulls in lifecycle, ahead of it, and says so", () => {
    const selection = selectCriteria(WRITE_CRITERIA, { only: new Set(["audit"]) });
    expect(keys(selection)).toEqual(["lifecycle", "audit"]);
    expect(selection.autoIncluded).toEqual(["lifecycle"]);
  });

  it("a milestone profile runs exactly its criteria, in registry order", () => {
    const selection = selectCriteria(WRITE_CRITERIA, { profile: WRITE_MILESTONES.m3 });
    expect(keys(selection)).toEqual(WRITE_MILESTONES.m3);
  });

  it("--skip lifecycle with a dependent selected is refused, not run", () => {
    const reasons = selectionRefusals(WRITE_CRITERIA, { skip: new Set(["lifecycle"]) });
    expect(reasons.join("\n")).toContain("--skip lifecycle cannot be combined with namespace");
  });

  it("--skip of a criterion nothing depends on is allowed", () => {
    expect(selectionRefusals(READ_CRITERIA, { skip: new Set(["export"]) })).toEqual([]);
    expect(keys(selectCriteria(READ_CRITERIA, { skip: new Set(["export"]) }))).not.toContain(
      "export",
    );
  });

  it("an unknown key is named, with the keys that do exist", () => {
    const [reason] = selectionRefusals(READ_CRITERIA, { only: new Set(["m2-3"]) });
    expect(reason).toContain('unknown criterion "m2-3"');
    expect(reason).toContain("liveness");
  });

  it("--only and --skip together is refused: --only already says what runs", () => {
    const reasons = selectionRefusals(READ_CRITERIA, {
      only: new Set(["dataset"]),
      skip: new Set(["export"]),
    });
    expect(reasons[0]).toContain("cannot be combined");
  });
});
