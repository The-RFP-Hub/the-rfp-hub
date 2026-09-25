/**
 * `shareCardModel` is the whole content contract of `/opportunities/[id]/card.png` in one pure
 * function — truncation, fallbacks and the URL, asserted without touching `next/og` or a route.
 */
import { shareCardModel } from "@/lib/share-card";
import type { Opportunity } from "@/lib/types";
import { describe, expect, it } from "vitest";

const base: Opportunity = {
  specVersion: "1.0.0",
  id: "acme:round-4",
  fundingType: "grant",
  title: "Retro Funding Round Four",
  description: "Grants for public-goods infrastructure.",
  summary: "One round, quarterly.",
  status: "open",
  operatingOrganizations: [
    { name: "Acme Foundation", slug: "acme", website: "https://acme.example.com" },
  ],
  sponsoringOrganizations: [],
  source: {
    publisher: "acme",
    submittedBy: "acme",
    submittedAt: "2026-08-01T09:00:00Z",
    ingestedVia: "publisher_api",
    originalId: "R4",
    verifiedAgainstSource: true,
    verifiedAt: "2026-08-10T09:00:00Z",
    snapshotUrl: "https://archive.example.com/r4",
  },
  ecosystems: ["Optimism", "Arbitrum", "Base", "zkSync", "Starknet"],
  categories: ["infrastructure"],
  eligibility: "Teams shipping open-source infrastructure.",
  applicationUrl: "https://acme.example.com/apply",
  website: "https://acme.example.com",
  fundingInfo: { currency: "USD", minAward: 5000, maxAward: 50000, allocated: 120000 },
  milestones: [],
  deadlines: [{ deadlineType: "fixed", date: "2099-09-30T23:59:00Z", label: "application" }],
  opensAt: "2026-08-01T00:00:00Z",
  postedAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
  fundingDetails: { fundingType: "grant", milestoneBased: false },
};

describe("shareCardModel", () => {
  it("builds the eyebrow, ecosystems (capped at four) and URL", () => {
    const model = shareCardModel(base, "https://rfpsear.ch");

    expect(model.eyebrow).toBe("Grant · Acme Foundation");
    expect(model.title).toBe("Retro Funding Round Four");
    expect(model.ecosystems).toBe("Optimism · Arbitrum · Base · zkSync");
    expect(model.award).toBe("$5k to $50k");
    expect(model.deadline).toBe("Sep 30, 2099");
    expect(model.url).toBe("https://rfpsear.ch/opportunities/acme%3Around-4");
    expect(model.positioning).toBe("Funded by the Ethereum Foundation Ecosystem Support Program");
  });

  it("truncates a long title to 120 characters with an ellipsis", () => {
    const longTitle = "A".repeat(200);
    const model = shareCardModel({ ...base, title: longTitle }, "https://rfpsear.ch");

    expect(model.title).toHaveLength(120);
    expect(model.title.endsWith("…")).toBe(true);
    expect(model.title.startsWith("A".repeat(119))).toBe(true);
  });

  it("truncates a long operator name to 60 characters with an ellipsis", () => {
    const model = shareCardModel(
      {
        ...base,
        operatingOrganizations: [{ name: "B".repeat(100), slug: "b" }],
      },
      "https://rfpsear.ch",
    );

    expect(model.eyebrow).toBe(`Grant · ${"B".repeat(59)}…`);
  });

  it("falls back when there is no operator, no award and no fixed deadline", () => {
    const { operatingOrganizations: _dropped, fundingInfo: _droppedFunding, ...rest } = base;
    const model = shareCardModel(
      {
        ...rest,
        operatingOrganizations: [] as unknown as Opportunity["operatingOrganizations"],
        deadlines: [{ deadlineType: "rolling", label: "application" }],
      },
      "https://rfpsear.ch",
    );

    expect(model.eyebrow).toBe("Grant");
    expect(model.award).toBeNull();
    expect(model.deadline).toBe("Rolling");
    expect(model.figures.map((f) => f.label)).toEqual(["Status", "Applications"]);
  });

  it("says so when there is no deadline at all", () => {
    const model = shareCardModel({ ...base, deadlines: [] }, "https://rfpsear.ch");
    expect(model.deadline).toBe("No deadline");
  });

  it("hides the ecosystems line when the listing states none", () => {
    const model = shareCardModel({ ...base, ecosystems: [] }, "https://rfpsear.ch");
    expect(model.ecosystems).toBe("");
  });

  it("percent-encodes the id in the URL", () => {
    const model = shareCardModel({ ...base, id: "legacy:round 4" }, "https://rfpsear.ch");
    expect(model.url).toBe("https://rfpsear.ch/opportunities/legacy%3Around%204");
  });
});
