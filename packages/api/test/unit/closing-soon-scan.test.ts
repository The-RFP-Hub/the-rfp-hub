/**
 * The "closing soon" walk returns the TRUE earliest inactivity closes — not the earliest of the
 * first N rows the database happened to order by clock.
 *
 * Driven through an in-memory page reader that keeps the repository's contract (ascending
 * `(clock, id)`, keyset after a cursor), so the two scenarios the review reproduced against a
 * 2,000-row cap can be built exactly, and every answer is checked against a brute-force sort of
 * the whole set.
 */
import { describe, expect, it } from "vitest";
import {
  type CandidatePageReader,
  earliestInactivityClosings,
} from "../../src/modules/services/review/closing-soon.js";
import { type StalenessFacts, inactivityClosesAt } from "../../src/modules/shared/staleness.js";

const DAY = 86_400_000;
const DAYS = 90;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const HORIZON = NOW.getTime() + 30 * DAY;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const fixed = (when: Date) => ({ deadlineType: "fixed" as const, date: when.toISOString() });
const ROLLING = { deadlineType: "rolling" as const };

type Row = StalenessFacts & { id: number };

let nextId = 1;
const make = (over: Partial<StalenessFacts>): Row => ({
  id: nextId++,
  deadlines: [ROLLING],
  lastSeenAt: at(-80),
  updatedAt: at(-400),
  ...over,
});

/** The repository's contract, in memory: ascending (clock, id), resumed strictly after a cursor. */
function reader(rows: Row[]): { read: CandidatePageReader<Row>; rowsRead: () => number } {
  const clock = (r: Row) => (r.lastSeenAt ?? r.updatedAt).getTime();
  const sorted = [...rows].sort((a, b) => clock(a) - clock(b) || a.id - b.id);
  let served = 0;
  return {
    read: async (after, size) => {
      const start =
        after === null
          ? 0
          : sorted.findIndex(
              (r) =>
                clock(r) > Date.parse(after.clockKey) ||
                (clock(r) === Date.parse(after.clockKey) && r.id > after.id),
            );
      const page = (start === -1 ? [] : sorted.slice(start, start + size)).map((row) => ({
        row,
        clockKey: new Date(clock(row)).toISOString(),
      }));
      served += page.length;
      return page;
    },
    rowsRead: () => served,
  };
}

/** What the answer must be: every row projected, filtered to the window, sorted, cut. */
function bruteForce(rows: Row[], limit: number) {
  const due = rows
    .map((row) => ({ row, closesAt: inactivityClosesAt(row, NOW, DAYS) }))
    .filter((d): d is { row: Row; closesAt: Date } => d.closesAt !== null)
    .filter((d) => d.closesAt.getTime() <= HORIZON)
    .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime() || a.row.id - b.row.id);
  return { ids: due.slice(0, limit).map((d) => d.row.id), truncated: due.length > limit };
}

const walk = (rows: Row[], limit: number, scan = { pageSize: 500, scanCap: 50_000 }) => {
  const r = reader(rows);
  return earliestInactivityClosings<Row>({
    readPage: r.read,
    now: NOW,
    horizon: HORIZON,
    inactiveDays: DAYS,
    limit,
    ...scan,
  }).then((result) => ({ ...result, rowsRead: r.rowsRead() }));
};

describe("the closing-soon walk", () => {
  it("finds a newer listing closing tomorrow behind 2,000 older ones a deadline postpones", async () => {
    // Older clocks (scanned first), each held open by a fixed deadline 20 days out.
    const postponed = Array.from({ length: 2000 }, (_, i) =>
      make({ deadlines: [ROLLING, fixed(at(20))], lastSeenAt: at(-100 - i / 1000) }),
    );
    const tomorrow = make({ lastSeenAt: at(-89) });
    const rows = [...postponed, tomorrow];

    const result = await walk(rows, 100);
    expect(result.due[0]?.row.id).toBe(tomorrow.id);
    expect(result.due[0]?.closesAt).toEqual(at(1));
    expect(result.due.map((d) => d.row.id)).toEqual(bruteForce(rows, 100).ids);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("does not come back empty when the first 2,000 rows all close beyond the window", async () => {
    const beyond = Array.from({ length: 2000 }, (_, i) =>
      make({ deadlines: [ROLLING, fixed(at(45))], lastSeenAt: at(-100 - i / 1000) }),
    );
    const real = make({ lastSeenAt: at(-80) });
    const rows = [...beyond, real];

    const result = await walk(rows, 100);
    expect(result.due.map((d) => d.row.id)).toEqual([real.id]);
    expect(result.due[0]?.closesAt).toEqual(at(10));
    expect(result.truncated).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("stops reading once no unread row can close earlier than what it holds", async () => {
    // 300 that close within days, then 5,000 whose clocks put them past the horizon's bound for
    // the top 10 — the walk must not read all of them.
    const early = Array.from({ length: 300 }, (_, i) => make({ lastSeenAt: at(-95 + i / 100) }));
    const later = Array.from({ length: 5000 }, (_, i) => make({ lastSeenAt: at(-70 + i / 1000) }));
    const rows = [...early, ...later];

    const result = await walk(rows, 10, { pageSize: 50, scanCap: 50_000 });
    expect(result.due.map((d) => d.row.id)).toEqual(bruteForce(rows, 10).ids);
    expect(result.rowsRead).toBeLessThan(100);
    expect(result.complete).toBe(true);
  });

  it("says it is incomplete when the safety cap stops it, never presenting a guess as the answer", async () => {
    const beyond = Array.from({ length: 200 }, (_, i) =>
      make({ deadlines: [ROLLING, fixed(at(45))], lastSeenAt: at(-100 - i / 1000) }),
    );
    const real = make({ lastSeenAt: at(-80) });

    const result = await walk([...beyond, real], 100, { pageSize: 20, scanCap: 50 });
    expect(result.complete).toBe(false);
    expect(result.due).toEqual([]);
  });

  it("agrees with a brute-force sort on mixed shapes, for every limit", async () => {
    const shapes = (i: number): Partial<StalenessFacts> => {
      const seen = at(-60 - ((i * 37) % 70));
      switch (i % 6) {
        case 0:
          return { lastSeenAt: seen };
        case 1:
          return { deadlines: [ROLLING, fixed(at((i % 50) - 10))], lastSeenAt: seen };
        case 2:
          return { deadlines: [fixed(at((i % 40) - 5))], lastSeenAt: seen };
        case 3:
          return { deadlines: [], lastSeenAt: null, updatedAt: seen };
        case 4:
          return { deadlines: [ROLLING, fixed(at(-20)), fixed(at(i % 35))], lastSeenAt: seen };
        default:
          return { deadlines: [fixed(at(-3))], lastSeenAt: seen };
      }
    };
    const rows = Array.from({ length: 600 }, (_, i) => make(shapes(i)));
    for (const limit of [1, 2, 7, 50, 200, 1000]) {
      const result = await walk(rows, limit, { pageSize: 13, scanCap: 50_000 });
      const expected = bruteForce(rows, limit);
      expect(
        result.due.map((d) => d.row.id),
        `limit ${limit}`,
      ).toEqual(expected.ids);
      expect(result.truncated, `limit ${limit}`).toBe(expected.truncated);
      expect(result.complete).toBe(true);
    }
  });
});
