import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import { type RegistryProgram, mapProgram } from "../../scripts/map-program.js";

// Trimmed real-shaped registry programs from an upstream funding-map /program-registry/search API.
const grantProgram: RegistryProgram = {
  id: "6a049b3188f4252180420a47",
  programId: "1479",
  type: "grant",
  isActive: true,
  deadline: null,
  submissionUrl: null,
  communities: [{ uid: "0x34…", name: "Filecoin", slug: "filecoin" }],
  createdAt: "2026-05-13T15:39:29.000Z",
  updatedAt: "2026-06-18T22:42:23.000Z",
  metadata: {
    title: "Filecoin ProPGF Batch 3",
    description: "A $2M milestone-based funding program.",
    shortDescription: "Filecoin ProPGF Batch 3",
    status: "Active",
    startsAt: "2026-05-26T00:00:00.000Z",
    endsAt: "2026-06-16T23:59:00.000Z",
    programBudget: "2000000",
    ecosystems: [],
    socialLinks: { twitter: "", discord: "", website: "" },
  },
};

const hackathonProgram: RegistryProgram = {
  programId: "1486",
  type: "hackathon",
  isActive: true,
  deadline: "2026-06-20T18:29:00.000Z",
  submissionUrl: "https://example.devfolio.co",
  communities: [{ name: "Ethereum", slug: "ethereum" }],
  metadata: {
    title: "Some Hackathon",
    description: "Build cool things.",
    programBudget: "2026 USD",
    ecosystems: ["Ethereum"],
  },
  hackathonMetadata: {
    startDate: "2026-06-01T18:29:00.000Z",
    endDate: "2026-06-30T18:29:00.000Z",
    location: "Online",
    // upstream sometimes sends amount as a string and float team bounds — must be coerced
    prizes: [{ amount: "2026", currency: "USD" }],
    teamSize: { min: "1", max: 5.0 },
  },
};

// Messy: non-URL submissionUrl (dropped) + non-numeric prize amount; relies on the provenance base.
const messyProgram: RegistryProgram = {
  programId: "9999",
  type: "bounty",
  isActive: false,
  submissionUrl: "not a url",
  communities: [],
  metadata: { title: "Messy Bounty", description: "", programBudget: "110 USDC" },
  bountyMetadata: {
    reward: { amount: "110", currency: "USDC" },
    skills: ["Content"],
    difficulty: "expert", // not in the Standard enum → must be dropped
  },
};

// vc_fund with dup ecosystems, an uppercase/underscore community slug, and a bad enum in `stages`.
const vcProgram: RegistryProgram = {
  programId: "555",
  type: "vc_fund",
  isActive: true,
  communities: [{ name: "Ethereum", slug: "OP_Mainnet" }],
  metadata: { title: "Fund X", description: "We invest.", ecosystems: ["Ethereum", "Ethereum"] },
  vcFundMetadata: {
    stages: ["seed", "bogus"],
    contactMethod: "form",
    activelyInvesting: true,
    thesis: "DeFi",
  },
};

const BASE = "https://example.org/programs";

describe("mapProgram", () => {
  it("maps a grant to a valid Standard object", () => {
    const o = mapProgram(grantProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.id).toBe("fundingmap:1479");
    expect(o.type).toBe("grant");
    expect(o.organization.name).toBe("Filecoin ProPGF Batch 3");
    expect(o.organization.slug).toBe("filecoin");
    expect(o.source.originalId).toBe("1479");
    expect(o.source.verifiedAgainstSource).toBeNull();
    expect(o.funding?.totalBudget).toBe(2000000);
    expect(o.ecosystems).toEqual(["Filecoin"]); // falls back to community when metadata empty
    expect(o.status).toBe("open");
    expect(o.grant).toEqual({}); // required, may be empty
  });

  it("honors a custom source system in the id/provenance namespace", () => {
    const o = mapProgram(grantProgram, { sourceSystem: "acme", programUrlBase: BASE });
    expect(o.id).toBe("acme:1479");
  });

  it("coerces hackathon dates/prizes and teamSize to integers, and parses '2026 USD'", () => {
    const o = mapProgram(hackathonProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.funding?.totalBudget).toBe(2026);
    expect(o.funding?.currency).toBe("USD");
    expect(o.hackathon?.startDate).toBe("2026-06-01T18:29:00.000Z");
    expect(o.hackathon?.prizes).toEqual([{ amount: 2026, currency: "USD" }]);
    expect(o.hackathon?.teamSize).toEqual({ min: 1, max: 5 }); // int, no currency
  });

  it("drops an invalid applicationUrl and uses the provenance base as source url", () => {
    const o = mapProgram(messyProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.applicationUrl).toBeUndefined();
    expect(o.source.url).toBe("https://example.org/programs/9999");
    expect(o.bounty?.reward).toEqual({ amount: 110, currency: "USDC" });
    expect(o.bounty?.difficulty).toBeUndefined(); // invalid enum dropped
  });

  it("dedupes arrays, slugifies the org slug, and filters type-block enums", () => {
    const o = mapProgram(vcProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.ecosystems).toEqual(["Ethereum"]); // deduped
    expect(o.organization.slug).toBe("op-mainnet"); // slugified from OP_Mainnet
    expect(o.vc_fund?.stages).toEqual(["seed"]); // "bogus" filtered out of the enum array
    expect(o.vc_fund?.contactMethod).toBe("form");
    expect(o.vc_fund?.activelyInvesting).toBe(true);
  });

  it("does NOT fabricate a source url when no base is supplied (entry then fails validation)", () => {
    const o = mapProgram(messyProgram); // no programUrlBase, no valid submission/website URL
    expect(o.source.url).toBeUndefined();
    expect(validateOpportunity(o).valid).toBe(false); // source.url is required
  });
});
