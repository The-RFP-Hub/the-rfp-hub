import { cardAward, compactUsd, daysUntil, summarizeLanding } from "@/lib/landing";
import type { OpportunitySummary } from "@/lib/types";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-09-15T12:00:00Z");

function entry(overrides: Partial<OpportunitySummary> & { id: string }): OpportunitySummary {
  return {
    specVersion: "1.0.0",
    fundingType: "grant",
    title: overrides.id,
    description: "",
    status: "open",
    operatingOrganizations: [{ slug: "acme", name: "Acme" }],
    source: {},
    ...overrides,
  } as OpportunitySummary;
}

describe("the front page tally", () => {
  const items = [
    entry({
      id: "a:hack",
      fundingType: "hackathon",
      fundingInfo: { currency: "USD", budget: 82_000 },
      deadlines: [{ deadlineType: "fixed", label: "submission", date: "2026-09-16T05:00:00Z" }],
    }),
    entry({
      id: "b:bounty",
      fundingType: "bounty",
      operatingOrganizations: [{ slug: "beta", name: "Beta" }],
      fundingInfo: { currency: "USD", maxAward: 1_000_000 },
      deadlines: [{ deadlineType: "rolling", label: "application" }],
    }),
    entry({
      id: "c:eth",
      fundingType: "bounty",
      operatingOrganizations: [{ slug: "gamma", name: "Gamma" }],
      fundingInfo: { currency: "ETH", maxAward: 200 },
      deadlines: [{ deadlineType: "fixed", label: "closes", date: "2026-12-01T00:00:00Z" }],
    }),
    entry({ id: "d:none", fundingType: "rfp" }),
  ];
  const summary = summarizeLanding(items, NOW);

  it("counts open listings, distinct operators and listings per type", () => {
    expect(summary.open).toBe(4);
    expect(summary.organizations).toBe(3);
    expect(summary.byType).toEqual({ hackathon: 1, bounty: 2, rfp: 1 });
  });

  it("sums USD award ceilings only, never budgets, and says how many it summed", () => {
    expect(summary.awardsUsd).toBe(1_000_000);
    expect(summary.awardsCounted).toBe(1);
  });

  it("puts fixed deadlines inside the window on the strip, soonest first, and nothing rolling", () => {
    expect(summary.closingSoon.map((item) => item.id)).toEqual(["a:hack"]);
    expect(summary.closingSoonTotal).toBe(1);
  });

  it("features the largest stated awards that are not already on the strip", () => {
    expect(summary.featured.map((item) => item.id)).toEqual(["b:bounty"]);
  });
});

describe("compact money", () => {
  it("rounds to the unit a headline can hold", () => {
    expect(compactUsd(143_501_675)).toBe("$144M");
    expect(compactUsd(2_500_000)).toBe("$2.5M");
    expect(compactUsd(82_000)).toBe("$82k");
    expect(compactUsd(500)).toBe("$500");
  });

  it("describes a card's award from whichever figure the publisher stated", () => {
    expect(cardAward(entry({ id: "x", fundingInfo: { currency: "USD", maxAward: 250_000 } }))).toBe(
      "Up to $250k",
    );
    expect(
      cardAward(
        entry({ id: "x", fundingInfo: { currency: "USD", minAward: 25_000, maxAward: 1e6 } }),
      ),
    ).toBe("$25k to $1M");
    expect(cardAward(entry({ id: "x", fundingInfo: { currency: "USD", budget: 45_000 } }))).toBe(
      "$45k pool",
    );
    expect(cardAward(entry({ id: "x", fundingInfo: { currency: "ETH", maxAward: 200 } }))).toBe(
      "Up to 200 ETH",
    );
    expect(cardAward(entry({ id: "x" }))).toBeNull();
  });

  it("counts days without going negative", () => {
    expect(daysUntil("2026-09-16T05:00:00Z", NOW)).toBe("1 day");
    expect(daysUntil("2026-09-23T12:00:00Z", NOW)).toBe("8 days");
    expect(daysUntil("2026-09-15T00:00:00Z", NOW)).toBe("today");
  });
});
