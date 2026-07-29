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

describe("mapProgram", () => {
  it("maps a grant to a valid Standard object in the re-cut shape", () => {
    const o = mapProgram(grantProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.id).toBe("fundingmap:1479");
    expect(o.fundingType).toBe("grant");
    expect(o).not.toHaveProperty("type");
    expect(o).not.toHaveProperty("organization");
    expect(o).not.toHaveProperty("closesAt");
    expect(o.sponsoringOrganizations).toHaveLength(1);
    // the upstream names no organisation, so the listing community stands in — NOT the program
    // title, which is not an organisation anyone can look up (see sponsorNamesOf)
    expect(o.sponsoringOrganizations[0]?.name).toBe("Filecoin");
    expect(o.sponsoringOrganizations[0]?.slug).toBe("filecoin");
    expect(o.source.originalId).toBe("1479");
    expect(o.source).not.toHaveProperty("url");
    expect(o.source.verifiedAgainstSource).toBeNull();
    expect(o.funding?.budget).toBe(2000000);
    expect(o.funding).not.toHaveProperty("totalBudget");
    expect(o.ecosystems).toEqual(["Filecoin"]); // falls back to community when metadata empty
    expect(o.status).toBe("open");
    expect(o.grant).toEqual({}); // required, may be empty
  });

  it("folds the single upstream deadline into deadlines[] with the 'application' label", () => {
    const o = mapProgram(grantProgram, { programUrlBase: BASE });
    expect(o.deadlines).toEqual([
      { type: "fixed", date: "2026-06-16T23:59:00.000Z", label: "application" },
    ]);
  });

  it("honors a custom source system in the id/provenance namespace", () => {
    const o = mapProgram(grantProgram, { sourceSystem: "acme", programUrlBase: BASE });
    expect(o.id).toBe("acme:1479");
  });

  it("coerces hackathon prizes/teamSize and parses '2026 USD'", () => {
    const o = mapProgram(hackathonProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.funding?.budget).toBe(2026);
    expect(o.funding?.currency).toBe("USD");
    expect(o.hackathon?.prizes).toEqual([{ amount: 2026, currency: "USD" }]);
    expect(o.hackathon?.teamSize).toEqual({ min: 1, max: 5 }); // int, no currency
  });

  it("moves every hackathon date field into labelled deadlines[], ordered earliest-first", () => {
    const o = mapProgram(hackathonProgram, { programUrlBase: BASE });
    // no date fields survive inside the block — the re-cut forbids them there
    expect(o.hackathon).not.toHaveProperty("startDate");
    expect(o.hackathon).not.toHaveProperty("endDate");
    expect(o.hackathon).not.toHaveProperty("registrationDeadline");
    expect(o.hackathon).not.toHaveProperty("submissionDeadline");
    expect(o.deadlines).toEqual([
      { type: "fixed", date: "2026-05-20T18:29:00.000Z", label: "registration" },
      { type: "fixed", date: "2026-06-01T18:29:00.000Z", label: "event start" },
      { type: "fixed", date: "2026-06-20T18:29:00.000Z", label: "application" },
      { type: "fixed", date: "2026-06-29T18:29:00.000Z", label: "submission" },
      { type: "fixed", date: "2026-06-30T18:29:00.000Z", label: "event end" },
    ]);
  });

  it("drops an invalid applicationUrl and falls back to the program page", () => {
    const o = mapProgram(messyProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    // source.url is gone; the program page now backs applicationUrl, the single link-back target
    expect(o.applicationUrl).toBe("https://example.org/programs/9999");
    expect(o.bounty?.reward).toEqual({ amount: 110, currency: "USDC" });
    expect(o.bounty?.difficulty).toBeUndefined(); // invalid enum dropped
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
    expect(o.sponsoringOrganizations[0]?.slug).toBe("op-mainnet"); // slugified from OP_Mainnet
    expect(o.vc_fund?.stages).toEqual(["seed"]); // "bogus" filtered out of the enum array
    expect(o.vc_fund?.contactMethod).toBe("form");
    expect(o.vc_fund?.activelyInvesting).toBe(true);
  });

  it("folds rfp.issuingOrganization, rfp.budget and rfp.proposalDeadline into the shared fields", () => {
    const o = mapProgram(rfpProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.sponsoringOrganizations[0]?.name).toBe("ZKsync Foundation");
    expect(o.funding).toMatchObject({ budget: 15000, currency: "USD" });
    expect(o.deadlines).toEqual([
      { type: "fixed", date: "2026-03-20T00:00:00.000Z", label: "application" },
    ]);
    expect(o.rfp).toEqual({
      scope: "Content strategy with KPIs.",
      requirements: ["Weekly reporting"],
    });
    expect(o.rfp).not.toHaveProperty("issuingOrganization");
    expect(o.rfp).not.toHaveProperty("budget");
    expect(o.rfp).not.toHaveProperty("proposalDeadline");
  });

  it("folds accelerator.applicationDeadline into deadlines[]", () => {
    const o = mapProgram(acceleratorProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.deadlines).toEqual([
      { type: "fixed", date: "2026-08-01T00:00:00.000Z", label: "application" },
    ]);
    expect(o.accelerator).not.toHaveProperty("applicationDeadline");
    expect(o.accelerator).toMatchObject({ programDurationWeeks: 12, batchSize: 20, stage: "seed" });
  });

  it("wraps the pre-re-cut scalar grant.fundingMechanism into fundingMechanisms[]", () => {
    const o = mapProgram(mechanismProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.grant?.fundingMechanisms).toEqual(["retroactive"]);
    expect(o.grant).not.toHaveProperty("fundingMechanism");
    expect(o.grant?.programModel).toBe("incentives"); // new open string, passed through
    expect(o.grant?.recurring).toBe(true);
    expect(o.grant?.milestoneBased).toBe(false);
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
    expect(o.grant?.fundingMechanisms).toEqual(["matching", "quadratic"]);
  });

  it("emits exactly one type block and never a second one", () => {
    for (const p of [grantProgram, hackathonProgram, messyProgram, vcProgram, rfpProgram]) {
      const o = mapProgram(p, { programUrlBase: BASE }) as Record<string, unknown>;
      const blocks = ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"].filter(
        (t) => o[t] !== undefined,
      );
      expect(blocks).toEqual([o.fundingType]);
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
