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

  describe("verified organizations first", () => {
    const org = (slug: string) =>
      [{ slug, name: slug }] as OpportunitySummary["operatingOrganizations"];
    const hand = [
      entry({ id: "g:big", title: "Big grant", fundingInfo: { currency: "USD", maxAward: 2e6 } }),
      entry({
        id: "g:ver-small",
        title: "Verified small grant",
        operatingOrganizations: org("ver"),
        fundingInfo: { currency: "USD", maxAward: 5_000 },
      }),
      entry({
        id: "g:ver-pool",
        title: "Verified pool grant",
        operatingOrganizations: org("ver"),
        fundingInfo: { currency: "USD", budget: 1e7 },
      }),
      entry({
        id: "g:ver-mid",
        title: "Verified mid grant",
        operatingOrganizations: org("other-ver"),
        fundingInfo: { currency: "USD", maxAward: 40_000 },
      }),
      entry({
        id: "h:big",
        fundingType: "hackathon",
        title: "Big hack",
        fundingInfo: { currency: "USD", budget: 400_000 },
      }),
      entry({
        id: "h:sponsored",
        fundingType: "hackathon",
        title: "Sponsored hack",
        sponsoringOrganizations: org("ver"),
        fundingInfo: { currency: "USD", budget: 90_000 },
      }),
      entry({
        id: "b:big",
        fundingType: "bounty",
        title: "Big bounty",
        fundingInfo: { currency: "USD", maxAward: 16e6 },
      }),
      entry({
        id: "b:small",
        fundingType: "bounty",
        title: "Small bounty",
        fundingInfo: { currency: "USD", maxAward: 1e6 },
      }),
    ];
    const verified = new Set(["ver", "other-ver"]);

    it("deals a verified organization's listing ahead of a larger unverified one", () => {
      expect(dealHand(hand, verified)[0]?.id).toBe("g:ver-mid");
    });

    it("ranks within the verified group by the usual rule: ceiling, then pool, then title", () => {
      // Both verified ceilings outrank the verified pool, however large the pool is.
      expect(dealHand(hand, verified)[0]?.id).toBe("g:ver-mid");
      const pools = hand.filter((item) => item.id !== "g:ver-mid" && item.id !== "g:ver-small");
      expect(dealHand(pools, verified)[0]?.id).toBe("g:ver-pool");
      const tie = [
        entry({ id: "v:b", title: "B", operatingOrganizations: org("ver") }),
        entry({ id: "v:a", title: "A", operatingOrganizations: org("ver") }),
        entry({ id: "u:0", title: "0", fundingInfo: { currency: "USD", maxAward: 9e6 } }),
      ];
      expect(dealHand(tie, verified)[0]?.id).toBe("v:a");
    });

    it("counts a verified sponsor as well as a verified operator", () => {
      expect(dealHand(hand, verified)[1]?.id).toBe("h:sponsored");
    });

    it("falls back to the usual rule in a type with no verified listing", () => {
      expect(dealHand(hand, verified)[2]?.id).toBe("b:big");
    });

    it("falls back to the usual rule everywhere when no organization is known to be verified", () => {
      expect(dealHand(hand).map((item) => item.id)).toEqual(["g:big", "h:big", "b:big"]);
      expect(dealHand(hand, new Set()).map((item) => item.id)).toEqual(["g:big", "h:big", "b:big"]);
    });

    it("deals a verified listing with a stated value ahead of a verified one without", () => {
      const tiers = [
        entry({ id: "v:none", title: "A first by title", operatingOrganizations: org("ver") }),
        entry({
          id: "v:pool",
          title: "Z pool",
          operatingOrganizations: org("ver"),
          fundingInfo: { currency: "USD", budget: 20_000 },
        }),
        entry({ id: "u:big", title: "Big", fundingInfo: { currency: "USD", maxAward: 9e6 } }),
      ];
      expect(dealHand(tiers, verified)[0]?.id).toBe("v:pool");
    });

    it("still deals a verified listing without a value ahead of an unverified one with a value", () => {
      const tiers = [
        entry({ id: "v:none", title: "No value", operatingOrganizations: org("ver") }),
        entry({ id: "u:big", title: "Big", fundingInfo: { currency: "USD", maxAward: 9e6 } }),
      ];
      expect(dealHand(tiers, verified)[0]?.id).toBe("v:none");
      expect(dealHand(tiers)[0]?.id).toBe("u:big");
    });

    it("is passed through the summary", () => {
      expect(summarizeLanding(hand, NOW, verified).hand.map((item) => item.id)).toEqual([
        "g:ver-mid",
        "h:sponsored",
        "b:big",
      ]);
    });
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
