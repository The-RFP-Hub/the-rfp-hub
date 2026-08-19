import {
  barGeometry,
  describeDuplicateCheck,
  formatCount,
  formatDay,
  formatInstant,
  formatSimilarity,
  seriesFor,
} from "@/lib/format";
import { describe, expect, it } from "vitest";

describe("formatDay", () => {
  it("formats a UTC calendar day without going through a local-timezone Date", () => {
    expect(formatDay("2026-08-14")).toBe("14 Aug");
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });

  it("returns anything it does not recognise unchanged rather than 'Invalid Date'", () => {
    expect(formatDay("not-a-day")).toBe("not-a-day");
    expect(formatDay("2026-13-01")).toBe("2026-13-01");
  });
});

describe("formatInstant", () => {
  it("renders an RFC 3339 instant in UTC", () => {
    expect(formatInstant("2026-08-14T09:05:00Z")).toBe("14 Aug 09:05 UTC");
  });

  it("has an honest answer for a missing timestamp", () => {
    expect(formatInstant(null)).toBe("—");
  });
});

describe("formatCount", () => {
  it("groups thousands without a locale, so the string is the same everywhere", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("formatSimilarity", () => {
  it("says when there is no similarity rather than showing 0%", () => {
    expect(formatSimilarity(null)).toBe("similarity unknown");
    expect(formatSimilarity(0.912)).toBe("91% similar");
  });
});

describe("barGeometry", () => {
  const points = [
    { day: "2026-08-12", value: 0 },
    { day: "2026-08-13", value: 5 },
    { day: "2026-08-14", value: 10 },
  ];

  it("scales bars against the tallest value", () => {
    const { bars, max } = barGeometry(points, 300, 100);
    expect(max).toBe(10);
    expect(bars).toHaveLength(3);
    expect(bars[2]?.height).toBe(100);
    expect(bars[1]?.height).toBe(50);
    expect(bars[0]?.height).toBe(0);
  });

  it("does not divide by zero on an all-zero window — the common case for a new listing", () => {
    const { bars, max } = barGeometry(
      points.map((point) => ({ ...point, value: 0 })),
      300,
      100,
    );
    expect(max).toBe(1);
    expect(bars.every((bar) => bar.height === 0)).toBe(true);
  });

  it("keeps a one-day window finite", () => {
    const { bars } = barGeometry([{ day: "2026-08-14", value: 3 }], 300, 100);
    expect(bars[0]?.width).toBeLessThanOrEqual(300);
    expect(Number.isFinite(bars[0]?.width ?? Number.NaN)).toBe(true);
  });

  it("has no bars and no crash for an empty window", () => {
    expect(barGeometry([], 300, 100).bars).toEqual([]);
  });
});

describe("seriesFor", () => {
  it("projects one metric out of the four counters", () => {
    const days = [
      { day: "2026-08-13", listViews: 1, detailViews: 2, sourceClicks: 3, applyClicks: 4 },
      { day: "2026-08-14", listViews: 5, detailViews: 6, sourceClicks: 7, applyClicks: 8 },
    ];
    expect(seriesFor(days, "applyClicks")).toEqual([
      { day: "2026-08-13", value: 4 },
      { day: "2026-08-14", value: 8 },
    ]);
  });
});

describe("describeDuplicateCheck", () => {
  it("distinguishes 'checked, nothing found' from 'not checked'", () => {
    expect(describeDuplicateCheck("ok", 0)).toContain("nothing similar");
    expect(describeDuplicateCheck("unavailable", 0)).toContain("could not run");
    expect(describeDuplicateCheck("unavailable", 0)).not.toContain("nothing similar");
    expect(describeDuplicateCheck("disabled", 0)).toContain("switched off");
  });

  it("counts matches with the right plural", () => {
    expect(describeDuplicateCheck("ok", 1)).toContain("1 possible match ");
    expect(describeDuplicateCheck("ok", 3)).toContain("3 possible matches");
  });
});
