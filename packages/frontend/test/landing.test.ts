import {
  awardParts,
  awardScale,
  cardAward,
  compactUsd,
  daysUntil,
  dealHand,
  handDate,
  poolUsd,
  summarizeLanding,
} from "@/lib/landing";
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

describe("the hero's hand", () => {
  const items = [
    entry({
      id: "g:small",
      title: "Small grant",
      fundingInfo: { currency: "USD", maxAward: 5_000 },
    }),
    entry({ id: "g:big", title: "Big grant", fundingInfo: { currency: "USD", maxAward: 2e6 } }),
    // A pool larger than any ceiling still loses to a stated ceiling: it is not what one award reaches.
    entry({ id: "g:pool", title: "Pool grant", fundingInfo: { currency: "USD", budget: 1e8 } }),
    entry({
      id: "h:b",
      fundingType: "hackathon",
      title: "B hack",
      fundingInfo: { budget: 50_000 },
    }),
    entry({
      id: "h:a",
      fundingType: "hackathon",
      title: "A hack",
      fundingInfo: { budget: 80_000 },
    }),
    entry({
      id: "h:eth",
      fundingType: "hackathon",
      fundingInfo: { currency: "ETH", maxAward: 900 },
    }),
    entry({ id: "b:z", fundingType: "bounty", title: "Zeta bounty" }),
    entry({ id: "b:a", fundingType: "bounty", title: "Alpha bounty" }),
    entry({ id: "r:1", fundingType: "rfp", fundingInfo: { currency: "USD", maxAward: 9e6 } }),
  ];

  it("deals one grant, hackathon and bounty: ceiling, else pool, else first by title", () => {
    expect(dealHand(items).map((item) => item.id)).toEqual(["g:big", "h:a", "b:a"]);
  });

  it("skips a type with no open listing rather than inventing one", () => {
    expect(
      dealHand(items.filter((item) => item.fundingType !== "hackathon")).map((i) => i.id),
    ).toEqual(["g:big", "b:a"]);
    expect(dealHand([])).toEqual([]);
  });

  it("is on the summary the page already loads", () => {
    expect(summarizeLanding(items, NOW).hand.map((item) => item.id)).toEqual([
      "g:big",
      "h:a",
      "b:a",
    ]);
  });

  it("reads a pool only when it is stated in USD", () => {
    expect(poolUsd(entry({ id: "x", fundingInfo: { budget: 45_000 } }))).toBe(45_000);
    expect(poolUsd(entry({ id: "x", fundingInfo: { currency: "ETH", budget: 45 } }))).toBeNull();
    expect(poolUsd(entry({ id: "x", fundingInfo: { currency: "USD", maxAward: 45 } }))).toBeNull();
  });

  it("sizes the figure on a log scale from $100 to $10M, and leaves other currencies small", () => {
    const at = (fundingInfo: OpportunitySummary["fundingInfo"]) =>
      awardScale(entry({ id: "x", fundingInfo }));
    expect(at({ currency: "USD", maxAward: 100 })).toBe(0);
    expect(at({ currency: "USD", maxAward: 100_000 })).toBeCloseTo(0.6);
    expect(at({ currency: "USD", maxAward: 1e7 })).toBe(1);
    expect(at({ currency: "USD", maxAward: 1e9 })).toBe(1);
    expect(at({ currency: "USD", budget: 1e5 })).toBeCloseTo(0.6);
    expect(at({ currency: "ETH", maxAward: 1e6 })).toBe(0);
    expect(at(undefined)).toBe(0);
  });

  it("splits the award line so only the amount is set large", () => {
    expect(awardParts("Up to $250k")).toEqual({ before: "Up to", figure: "$250k" });
    expect(awardParts("$25k to $1M")).toEqual({ before: "$25k to", figure: "$1M" });
    expect(awardParts("From $5k")).toEqual({ before: "From", figure: "$5k" });
    expect(awardParts("$45k pool")).toEqual({ figure: "$45k", after: "pool" });
    expect(awardParts("Up to 200 ETH")).toEqual({ before: "Up to", figure: "200 ETH" });
  });

  it("dates a card by its next fixed date and that date's own label, else rolling", () => {
    const dated = entry({
      id: "x",
      deadlines: [
        { deadlineType: "fixed", label: "closes", date: "2026-09-01T00:00:00Z" },
        { deadlineType: "fixed", label: "submission", date: "2026-10-30T00:00:00Z" },
      ],
    });
    expect(handDate(dated, NOW)).toMatch(/^submission · /);
    expect(
      handDate(
        entry({ id: "x", deadlines: [{ deadlineType: "fixed", date: "2026-10-30T00:00:00Z" }] }),
        NOW,
      ),
    ).toMatch(/^date · /);
    expect(handDate(entry({ id: "x", deadlines: [{ deadlineType: "rolling" }] }), NOW)).toBe(
      "Rolling",
    );
    expect(handDate(entry({ id: "x" }), NOW)).toBeNull();
  });
});
