/**
 * `inactivityClosesAt` is `stalenessClosureReason` solved for time — so for any row, the job's own
 * decision must flip from "stays open" to `inactive` exactly at the instant the list names, and
 * the rows the list leaves out must be the ones the inactivity pass never closes.
 */
import { describe, expect, it } from "vitest";
import { nextDeadlineAt } from "../../src/modules/shared/deadlines.js";
import {
  type StalenessFacts,
  closingDriver,
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
    // At the deadline itself no fixed date is left AFTER it, and the clock ran out long ago.
    expect(decide(facts, at(10))).toBe("inactive");
    expect(decide(facts, new Date(at(10).getTime() + 1))).toBe("inactive");
  });

  it("keeps a fixed deadline that has ALREADY passed: the job did not close the row before it", () => {
    // Codex's case. Today is 30 Oct; seen 22 Jul (+90 days = 20 Oct); fixed deadline 29 Oct.
    const now = new Date("2026-10-30T12:00:00.000Z");
    const deadline = new Date("2026-10-29T12:00:00.000Z");
    const facts = row({
      deadlines: [{ deadlineType: "rolling" }, fixed(deadline)],
      lastSeenAt: new Date("2026-07-22T12:00:00.000Z"),
    });
    const closesAt = inactivityClosesAt(facts, now, DAYS);
    expect(closesAt).toEqual(deadline);
    // Not 20 Oct: just after it, the 29 Oct deadline was still ahead and the job kept the row open.
    expect(decide(facts, new Date("2026-10-20T12:00:00.001Z"))).toBeNull();
    expect(decide(facts, new Date(deadline.getTime() - 1))).toBeNull();
    expect(decide(facts, deadline)).toBe("inactive");
    // A past projection means "the next run": the rule says inactive now.
    expect(decide(facts, now)).toBe("inactive");
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
      // Exactly at it: inactive when the deadline decides (the clock test was already true), not yet
      // when the clock decides (the clock test is strict).
      const deadlineDecides = fixedDates.some((d) => Date.parse(d.date) === closesAt.getTime());
      expect(decide(facts, closesAt)).toBe(deadlineDecides ? "inactive" : null);
    },
  );

  it("names the one instant a quiet fixed-only entry is inactive: exactly its final deadline", () => {
    // `isPastDue` is `latest < t` and `nextDeadlineAt` is `> t`, so at t = L neither holds and the
    // clock test alone decides. The production predicate is unchanged; the projection follows it.
    const facts = row({ deadlines: [fixed(at(3)), fixed(at(10))], lastSeenAt: at(-300) });
    expect(inactivityClosesAt(facts, NOW, DAYS)).toEqual(at(10));
    expect(decide(facts, NOW)).toBeNull();
    expect(decide(facts, new Date(at(10).getTime() - 1))).toBeNull();
    expect(decide(facts, at(10))).toBe("inactive");
    expect(decide(facts, new Date(at(10).getTime() + 1))).toBe("past_due");
  });

  it("names nothing for a fixed-only entry whose clock has not run out by its final deadline", () => {
    const facts = row({ deadlines: [fixed(at(10))], lastSeenAt: at(-50) });
    expect(inactivityClosesAt(facts, NOW, DAYS)).toBeNull();
    for (const t of [at(10).getTime() - 1, at(10).getTime(), at(10).getTime() + 1]) {
      expect(decide(facts, new Date(t))).not.toBe("inactive");
    }
  });

  it("never names an instant earlier than clock + days, which the scan's early stop relies on", () => {
    const shapes = [
      row({}),
      row({ deadlines: [] }),
      row({ deadlines: [{ deadlineType: "rolling" }, fixed(at(-5))], lastSeenAt: at(-120) }),
      row({ deadlines: [{ deadlineType: "rolling" }, fixed(at(40))], lastSeenAt: at(-10) }),
      row({ deadlines: [fixed(at(30))], lastSeenAt: at(-200) }),
    ];
    for (const facts of shapes) {
      const closesAt = inactivityClosesAt(facts, NOW, DAYS);
      expect(closesAt).not.toBeNull();
      expect((closesAt as Date).getTime()).toBeGreaterThanOrEqual(
        inactivityClockOf(facts).getTime() + DAYS * DAY,
      );
    }
  });

  it("names no inactivity date for a past-due entry, which closes on its deadlines instead", () => {
    const facts = row({ deadlines: [fixed(at(-1))], lastSeenAt: NOW });
    expect(inactivityClosesAt(facts, NOW, DAYS)).toBeNull();
    expect(decide(facts, NOW)).toBe("past_due");
  });

  describe("what decides the close — whether a confirmation can move it", () => {
    it.each([
      ["rolling, no fixed date", row({}), "inactivity"],
      ["no deadlines at all", row({ deadlines: [] }), "inactivity"],
      [
        "rolling, last deadline sooner than a fresh clock would run",
        row({ deadlines: [{ deadlineType: "rolling" }, fixed(at(10))], lastSeenAt: at(-100) }),
        "inactivity",
      ],
      [
        "rolling, last deadline later than a fresh clock would run",
        row({ deadlines: [{ deadlineType: "rolling" }, fixed(at(120))], lastSeenAt: at(-100) }),
        "final_deadline",
      ],
      [
        "fixed-only and quiet: inactive exactly at its final deadline",
        row({ deadlines: [fixed(at(10))], lastSeenAt: at(-300) }),
        "final_deadline",
      ],
      [
        "fixed-only and recently seen: past due after its final deadline",
        row({ deadlines: [fixed(at(10))], lastSeenAt: at(-1) }),
        "final_deadline",
      ],
      [
        "fixed-only, deadline beyond a fresh clock",
        row({ deadlines: [fixed(at(200))], lastSeenAt: at(-50) }),
        "final_deadline",
      ],
    ])("%s", (_label, facts, expected) => {
      expect(closingDriver(facts, NOW, DAYS)).toBe(expected);
      // The definition, restated against the projection: `inactivity` exactly when a fresh clock
      // moves the earliest close later.
      const before = inactivityClosesAt(facts, NOW, DAYS);
      const after = inactivityClosesAt({ ...facts, lastSeenAt: NOW }, NOW, DAYS);
      const moves = after !== null && (before === null || after.getTime() > before.getTime());
      expect(moves).toBe(expected === "inactivity");
    });
  });
});
