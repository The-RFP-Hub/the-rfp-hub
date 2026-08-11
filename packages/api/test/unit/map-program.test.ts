import type { DetailsByFundingType, FundingType, Opportunity } from "@the-rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import { mapProgram } from "../../scripts/map-program.js";
import {
  UPSTREAM_PROGRAMS,
  acceleratorProgram,
  grantProgram,
  hackathonProgram,
  mechanismProgram,
  messyProgram,
  rfpProgram,
  vcProgram,
} from "../fixtures/upstream-programs.js";

const BASE = "https://example.org/programs";

/** Narrow `fundingDetails` to the shape its tag names (asserting the tag along the way). */
function details<T extends FundingType>(o: Opportunity, type: T): DetailsByFundingType[T] {
  expect(o.fundingDetails.fundingType).toBe(type);
  return o.fundingDetails as DetailsByFundingType[T];
}

describe("mapProgram", () => {
  it("maps a grant to a valid Standard object in the re-cut shape", () => {
    const o = mapProgram(grantProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.id).toBe("fundingmap:1479");
    expect(o.fundingType).toBe("grant");
    expect(o).not.toHaveProperty("type");
    expect(o).not.toHaveProperty("organization");
    expect(o).not.toHaveProperty("sponsoringOrganizations"); // operating is the array ingests fill
    expect(o).not.toHaveProperty("closesAt");
    expect(o.operatingOrganizations).toHaveLength(1);
    expect(o.operatingOrganizations[0]?.name).toBe("Filecoin ProPGF Batch 3");
    expect(o.operatingOrganizations[0]?.slug).toBe("filecoin");
    expect(o.source.originalId).toBe("1479");
    expect(o.source).not.toHaveProperty("url");
    expect(o.source.verifiedAgainstSource).toBeNull();
    expect(o.fundingInfo?.budget).toBe(2000000);
    expect(o.fundingInfo).not.toHaveProperty("totalBudget");
    expect(o.ecosystems).toEqual(["Filecoin"]); // falls back to community when metadata empty
    expect(o.status).toBe("open");
    expect(o.fundingDetails).toEqual({ fundingType: "grant" }); // required; may carry only its tag
  });

  it("folds the single upstream deadline into deadlines[] with the 'application' label", () => {
    const o = mapProgram(grantProgram, { programUrlBase: BASE });
    expect(o.deadlines).toEqual([
      { deadlineType: "fixed", date: "2026-06-16T23:59:00.000Z", label: "application" },
    ]);
  });

  it("honors a custom source system in the id/provenance namespace", () => {
    const o = mapProgram(grantProgram, { sourceSystem: "acme", programUrlBase: BASE });
    expect(o.id).toBe("acme:1479");
  });

  it("coerces hackathon prizes/teamSize and parses '2026 USD'", () => {
    const o = mapProgram(hackathonProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.fundingInfo?.budget).toBe(2026);
    expect(o.fundingInfo?.currency).toBe("USD");
    const hackathon = details(o, "hackathon");
    expect(hackathon.prizes).toEqual([{ amount: 2026 }]); // no per-prize currency in the re-cut
    expect(hackathon.teamSize).toEqual({ min: 1, max: 5 }); // int, no currency
  });

  it("moves every hackathon date field into labelled deadlines[], ordered earliest-first", () => {
    const o = mapProgram(hackathonProgram, { programUrlBase: BASE });
    // no date fields survive inside the details — the re-cut forbids them there
    expect(o.fundingDetails).not.toHaveProperty("startDate");
    expect(o.fundingDetails).not.toHaveProperty("endDate");
    expect(o.fundingDetails).not.toHaveProperty("registrationDeadline");
    expect(o.fundingDetails).not.toHaveProperty("submissionDeadline");
    expect(o.deadlines).toEqual([
      { deadlineType: "fixed", date: "2026-05-20T18:29:00.000Z", label: "registration" },
      { deadlineType: "fixed", date: "2026-06-01T18:29:00.000Z", label: "event start" },
      { deadlineType: "fixed", date: "2026-06-20T18:29:00.000Z", label: "application" },
      { deadlineType: "fixed", date: "2026-06-29T18:29:00.000Z", label: "submission" },
      { deadlineType: "fixed", date: "2026-06-30T18:29:00.000Z", label: "event end" },
    ]);
  });

  it("drops an invalid applicationUrl and falls back to the program page", () => {
    const o = mapProgram(messyProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    // source.url is gone; the program page now backs applicationUrl, the single link-back target
    expect(o.applicationUrl).toBe("https://example.org/programs/9999");
    const bounty = details(o, "bounty");
    expect(bounty.reward).toBe(110); // plain number — denominated by fundingInfo.currency
    expect(o.fundingInfo?.currency).toBe("USDC"); // parsed from "110 USDC"
    expect(bounty.difficulty).toBeUndefined(); // invalid enum dropped
  });

  it("classifies a platform bug bounty as security and synthesizes the honest tier table", () => {
    // The real upstream never extracts a tier table, so its security bug bounties arrive as a
    // bare scalar — indistinguishable by shape from a task listing. The domain signals decide,
    // and the scalar becomes the one thing it actually is on such a listing: a ceiling.
    const o = mapProgram(
      {
        programId: "9001",
        type: "bounty",
        isActive: true,
        metadata: { title: "Lido Bug Bounty", description: "Standing bug bounty." },
        bountyMetadata: { platform: "Immunefi", reward: { amount: 2000000, currency: "USD" } },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    const bounty = details(o, "bounty");
    expect(bounty.bountyKind).toBe("security");
    expect(bounty).not.toHaveProperty("reward"); // forbidden on security — the table carries it
    expect(bounty.rewardTiers).toEqual([
      { label: "any severity", payout: { model: "up_to", max: 2000000 } },
    ]);
    expect(o.fundingInfo?.currency).toBe("USD");
  });

  it("classifies a bug bounty by name alone, and with no figure the tier is discretionary", () => {
    const o = mapProgram(
      {
        programId: "9002",
        type: "bounty",
        isActive: true,
        metadata: { title: "Acme Protocol Bug Bounty", description: "Report vulnerabilities." },
        bountyMetadata: {},
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    const bounty = details(o, "bounty");
    expect(bounty.bountyKind).toBe("security");
    expect(bounty.rewardTiers).toEqual([
      { label: "any severity", payout: { model: "discretionary" } },
    ]);
  });

  it("keeps a task-board listing a task even though it is called a bounty", () => {
    // "Messy Bounty" has 'bounty' in its name but no bug-bounty phrase and no security
    // platform: it stays a task with its scalar reward. The word alone must not flip the kind.
    const o = mapProgram(messyProgram, { programUrlBase: BASE });
    const bounty = details(o, "bounty");
    expect(bounty.bountyKind).toBe("task");
    expect(bounty.reward).toBe(110);
    expect(bounty).not.toHaveProperty("rewardTiers");
  });

  it("hoists an upstream per-item currency into fundingInfo.currency when none is set", () => {
    // No programBudget / rfp.budget currency — the reward's own currency is the only signal.
    const o = mapProgram(
      {
        programId: "42",
        type: "bounty",
        isActive: true,
        metadata: { title: "Hoist Bounty", description: "d" },
        bountyMetadata: { reward: { amount: 250, currency: "OP" } },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    expect(details(o, "bounty").reward).toBe(250);
    expect(o.fundingInfo).toEqual({ currency: "OP" }); // hoisted, not dropped
  });

  it("prefers the document-level currency over a disagreeing per-item one, keeping the amount", () => {
    // fundingInfo.currency (from programBudget "1000 USD") disagrees with the reward's "OP".
    // The Standard cannot express the disagreement, so ingestion normalizes to the document-wide
    // currency — and the amount survives rather than being dropped.
    const o = mapProgram(
      {
        programId: "43",
        type: "bounty",
        isActive: true,
        metadata: { title: "Clash Bounty", description: "d", programBudget: "1000 USD" },
        bountyMetadata: { reward: { amount: 250, currency: "OP" } },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.fundingInfo).toEqual({ budget: 1000, currency: "USD" }); // document level wins
    expect(details(o, "bounty").reward).toBe(250); // amount kept
  });

  it("hoists a checkSize currency and strips it from the emitted range", () => {
    const o = mapProgram(
      {
        ...vcProgram,
        vcFundMetadata: { checkSize: { min: 50000, max: 500000, currency: "EUR" } },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    expect(details(o, "vc_fund").checkSize).toEqual({ min: 50000, max: 500000 });
    expect(o.fundingInfo?.currency).toBe("EUR");
  });

  it("coerces accelerator.funding to a plain number from the legacy money object", () => {
    const o = mapProgram(
      {
        ...acceleratorProgram,
        acceleratorMetadata: { funding: { amount: 100000, currency: "USD" } },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    expect(details(o, "accelerator").funding).toBe(100000);
    expect(o.fundingInfo?.currency).toBe("USD");
  });

  it("still validates with no program-url base, since source has no required member", () => {
    const o = mapProgram(messyProgram); // no programUrlBase, no valid submission/website URL
    expect(o.applicationUrl).toBeUndefined();
    expect(validateOpportunity(o).valid).toBe(true);
  });

  it("dedupes arrays, slugifies the org slug, and filters type-block enums", () => {
    const o = mapProgram(vcProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.ecosystems).toEqual(["Ethereum"]); // deduped
    expect(o.operatingOrganizations[0]?.slug).toBe("op-mainnet"); // slugified from OP_Mainnet
    const vcFund = details(o, "vc_fund");
    expect(vcFund.stages).toEqual(["seed"]); // "bogus" filtered out of the enum array
    expect(vcFund.contactMethod).toBe("form");
    expect(vcFund.activelyInvesting).toBe(true);
  });

  it("folds rfp.issuingOrganization, rfp.budget and rfp.proposalDeadline into the shared fields", () => {
    const o = mapProgram(rfpProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.operatingOrganizations[0]?.name).toBe("ZKsync Foundation");
    expect(o.fundingInfo).toMatchObject({ budget: 15000, currency: "USD" });
    expect(o.deadlines).toEqual([
      { deadlineType: "fixed", date: "2026-03-20T00:00:00.000Z", label: "application" },
    ]);
    expect(o.fundingDetails).toEqual({
      fundingType: "rfp",
      scope: "Content strategy with KPIs.",
      requirements: ["Weekly reporting"],
    });
    expect(o.fundingDetails).not.toHaveProperty("issuingOrganization");
    expect(o.fundingDetails).not.toHaveProperty("budget");
    expect(o.fundingDetails).not.toHaveProperty("proposalDeadline");
  });

  it("folds accelerator.applicationDeadline into deadlines[]", () => {
    const o = mapProgram(acceleratorProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.deadlines).toEqual([
      { deadlineType: "fixed", date: "2026-08-01T00:00:00.000Z", label: "application" },
    ]);
    expect(o.fundingDetails).not.toHaveProperty("applicationDeadline");
    expect(o.fundingDetails).toMatchObject({
      fundingType: "accelerator",
      programDurationWeeks: 12,
      batchSize: 20,
      stage: "seed",
    });
  });

  it("wraps the pre-re-cut scalar grant.fundingMechanism into fundingMechanisms[]", () => {
    const o = mapProgram(mechanismProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    const grant = details(o, "grant");
    expect(grant.fundingMechanisms).toEqual(["retroactive"]);
    expect(grant).not.toHaveProperty("fundingMechanism");
    expect(grant.programModel).toBe("incentives"); // new open string, passed through
    expect(grant.recurring).toBe(true);
    expect(grant.milestoneBased).toBe(false);
  });

  it("keeps an already-array fundingMechanisms and admits the new 'matching' value", () => {
    const o = mapProgram(
      {
        ...mechanismProgram,
        grantMetadata: { fundingMechanisms: ["matching", "quadratic", "bogus"] },
      },
      { programUrlBase: BASE },
    );
    expect(validateOpportunity(o).valid).toBe(true);
    expect(details(o, "grant").fundingMechanisms).toEqual(["matching", "quadratic"]);
  });

  it("emits fundingDetails tagged as the fundingType, and no legacy top-level block", () => {
    for (const p of [grantProgram, hackathonProgram, messyProgram, vcProgram, rfpProgram]) {
      const o = mapProgram(p, { programUrlBase: BASE });
      expect(o.fundingDetails.fundingType).toBe(o.fundingType);
      const record = o as unknown as Record<string, unknown>;
      for (const t of ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"]) {
        expect(record[t], `no legacy top-level '${t}' block`).toBeUndefined();
      }
    }
  });
});

/**
 * The contract in one place: for EVERY recorded upstream shape, the mapper's output must validate
 * against the real published schema — not a copy, not a subset. Adding a fixture to
 * UPSTREAM_PROGRAMS enrolls it here automatically, so a new upstream shape cannot be recorded
 * without also proving it maps to a conforming document.
 */
describe("mapper output conforms for every recorded upstream shape", () => {
  for (const [name, program] of Object.entries(UPSTREAM_PROGRAMS)) {
    it(`${name} → a valid Standard document`, () => {
      const o = mapProgram(program, { programUrlBase: BASE });
      const { valid, errors } = validateOpportunity(o);
      if (!valid) console.error(name, humanizeErrors(errors, o));
      expect(valid).toBe(true);
    });

    it(`${name} → validates with no program-url base either`, () => {
      const o = mapProgram(program);
      const { valid, errors } = validateOpportunity(o);
      if (!valid) console.error(name, humanizeErrors(errors, o));
      expect(valid).toBe(true);
    });
  }
});
