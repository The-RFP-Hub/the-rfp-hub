/**
 * Pure unit tests for the derivations that replaced the removed `closesAt` scalar:
 * `nextDeadlineAt` (the sort/filter key) and `isPastDue` (the re-keyed auto-close predicate).
 */
import type { Deadline } from "@the-rfp-hub/standard";
import { describe, expect, it } from "vitest";
import {
  hasRollingDeadline,
  isPastDue,
  latestFixedDeadlineAt,
  nextDeadlineAt,
} from "../../src/modules/shared/deadlines.js";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const fixed = (date: string, label?: string): Deadline => ({ type: "fixed", date, label });
const rolling = (label?: string): Deadline => ({ type: "rolling", label });

describe("nextDeadlineAt", () => {
  it("returns the earliest fixed deadline still in the future", () => {
    const d = [fixed("2026-12-01T00:00:00.000Z"), fixed("2026-08-15T00:00:00.000Z")];
    expect(nextDeadlineAt(d, NOW)?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("skips fixed deadlines in the past", () => {
    const d = [fixed("2026-01-01T00:00:00.000Z"), fixed("2026-09-01T00:00:00.000Z")];
    expect(nextDeadlineAt(d, NOW)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("is null when every fixed deadline is in the past", () => {
    expect(nextDeadlineAt([fixed("2026-01-01T00:00:00.000Z")], NOW)).toBeNull();
  });

  it("is null for a rolling-only record", () => {
    expect(nextDeadlineAt([rolling("application")], NOW)).toBeNull();
  });

  it("is null for an empty or absent deadlines array", () => {
    expect(nextDeadlineAt([], NOW)).toBeNull();
    expect(nextDeadlineAt(undefined, NOW)).toBeNull();
    expect(nextDeadlineAt(null, NOW)).toBeNull();
  });

  it("ignores rolling entries when a future fixed deadline exists", () => {
    const d = [rolling(), fixed("2026-08-01T00:00:00.000Z")];
    expect(nextDeadlineAt(d, NOW)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ignores unparseable or missing dates rather than throwing", () => {
    const d = [
      { type: "fixed", date: "not a date" } as Deadline,
      { type: "fixed" } as Deadline,
      fixed("2026-08-01T00:00:00.000Z"),
    ];
    expect(nextDeadlineAt(d, NOW)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("is label-agnostic — an event boundary counts as the next date", () => {
    const d = [fixed("2026-07-10T00:00:00.000Z", "event start")];
    expect(nextDeadlineAt(d, NOW)?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("hasRollingDeadline / latestFixedDeadlineAt", () => {
  it("detects a rolling entry", () => {
    expect(hasRollingDeadline([rolling()])).toBe(true);
    expect(hasRollingDeadline([fixed("2026-08-01T00:00:00.000Z")])).toBe(false);
    expect(hasRollingDeadline(undefined)).toBe(false);
  });

  it("returns the latest fixed date, or null when there is none", () => {
    const d = [fixed("2026-01-01T00:00:00.000Z"), fixed("2026-03-01T00:00:00.000Z")];
    expect(latestFixedDeadlineAt(d)?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(latestFixedDeadlineAt([rolling()])).toBeNull();
  });
});

describe("isPastDue (auto-close / staleness predicate)", () => {
  it("is true when the latest fixed deadline has passed and nothing is rolling", () => {
    const d = [fixed("2026-01-01T00:00:00.000Z"), fixed("2026-03-01T00:00:00.000Z")];
    expect(isPastDue(d, NOW)).toBe(true);
  });

  it("is false while a fixed deadline is still upcoming", () => {
    expect(isPastDue([fixed("2026-09-01T00:00:00.000Z")], NOW)).toBe(false);
  });

  it("NEVER auto-closes a rolling program, however old its fixed dates are", () => {
    expect(isPastDue([fixed("2020-01-01T00:00:00.000Z"), rolling()], NOW)).toBe(false);
    expect(isPastDue([rolling()], NOW)).toBe(false);
  });

  it("is false when there are no deadlines at all", () => {
    expect(isPastDue([], NOW)).toBe(false);
    expect(isPastDue(undefined, NOW)).toBe(false);
  });
});
