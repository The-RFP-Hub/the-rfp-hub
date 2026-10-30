/**
 * `inactivityClosesAt` is `stalenessClosureReason` solved for time — so for any row, the job's own
 * decision must flip from "stays open" to `inactive` exactly at the instant the list names, and
 * the rows the list leaves out must be the ones the inactivity pass never closes.
 */
import { describe, expect, it } from "vitest";
import { nextDeadlineAt } from "../../src/modules/shared/deadlines.js";
import {
  type StalenessFacts,
  inactiveBeforeOf,
  inactivityClockOf,
  inactivityClosesAt,
  stalenessClosureReason,
} from "../../src/modules/shared/staleness.js";

const DAY = 86_400_000;
const DAYS = 90;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const fixed = (when: Date) => ({ deadlineType: "fixed" as const, date: when.toISOString() });

const row = (over: Partial<StalenessFacts>): StalenessFacts => ({
  deadlines: [{ deadlineType: "rolling" }],
  lastSeenAt: at(-80),
  updatedAt: at(-200),
  ...over,
});

const decide = (facts: StalenessFacts, when: Date) =>
  stalenessClosureReason(
    facts,
    nextDeadlineAt(facts.deadlines, when),
    when,
    inactiveBeforeOf(when, DAYS),
  );

describe("the staleness rule", () => {
  it("reads the clock from last_seen_at, falling back to updated_at", () => {
    expect(inactivityClockOf(row({}))).toEqual(at(-80));
    expect(inactivityClockOf(row({ lastSeenAt: null }))).toEqual(at(-200));
  });

  it.each([
    ["rolling, seen 80 days ago", row({})],
    ["no deadlines at all", row({ deadlines: [] })],
    ["never seen, edited 85 days ago", row({ lastSeenAt: null, updatedAt: at(-85) })],
    [
      "rolling with a fixed date long past",
      row({ deadlines: [{ deadlineType: "rolling" }, fixed(at(-300))] }),
    ],
  ])("closes %s exactly when the list says", (_label, facts) => {
    const closesAt = inactivityClosesAt(facts, NOW, DAYS);
    expect(closesAt).not.toBeNull();
    const t = (closesAt as Date).getTime();
    expect(decide(facts, new Date(t - 1))).toBeNull();
    expect(decide(facts, new Date(t))).toBeNull();
    expect(decide(facts, new Date(t + 1))).toBe("inactive");
  });

  it("POSTPONES a quiet rolling programme to its last fixed deadline, it does not spare it", () => {
    // The review finding's case: quiet for 100 days, a fixed date 10 days ahead.
    const facts = row({
      deadlines: [{ deadlineType: "rolling" }, fixed(at(10))],
      lastSeenAt: at(-100),
    });
    const closesAt = inactivityClosesAt(facts, NOW, DAYS);
    expect(closesAt).toEqual(at(10));
    expect(decide(facts, NOW)).toBeNull();
    expect(decide(facts, new Date(at(10).getTime() - 1))).toBeNull();
    expect(decide(facts, new Date(at(10).getTime() + 1))).toBe("inactive");
  });

  it.each([
    ["the clock runs out after the last deadline", at(-85), [fixed(at(2))], at(5)],
    [
      "the last deadline comes after the clock runs out",
      at(-100),
      [fixed(at(3)), fixed(at(20))],
      at(20),
    ],
    ["the last deadline is beyond any window", at(-300), [fixed(at(400))], at(400)],
  ])(
    "projects max(clock + days, last fixed deadline) when %s",
    (_label, seen, fixedDates, expected) => {
      const facts = row({
        deadlines: [{ deadlineType: "rolling" }, ...fixedDates],
        lastSeenAt: seen,
      });
      const closesAt = inactivityClosesAt(facts, NOW, DAYS) as Date;
      expect(closesAt).toEqual(expected);
      // The job's own predicate, evaluated around the projected instant.
      expect(decide(facts, new Date(closesAt.getTime() - 1))).toBeNull();
      expect(decide(facts, new Date(closesAt.getTime() + 1))).toBe("inactive");
    },
  );

  it("names no inactivity date for fixed deadlines without rolling intake: those close as past due", () => {
    const facts = row({ deadlines: [fixed(at(10))], lastSeenAt: at(-300) });
    expect(inactivityClosesAt(facts, NOW, DAYS)).toBeNull();
    expect(decide(facts, NOW)).toBeNull();
    expect(decide(facts, at(11))).toBe("past_due");
  });

  it("names no inactivity date for a past-due entry, which closes on its deadlines instead", () => {
    const facts = row({ deadlines: [fixed(at(-1))], lastSeenAt: NOW });
    expect(inactivityClosesAt(facts, NOW, DAYS)).toBeNull();
    expect(decide(facts, NOW)).toBe("past_due");
  });
});
