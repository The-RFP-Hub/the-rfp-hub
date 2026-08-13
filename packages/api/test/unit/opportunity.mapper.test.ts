import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import type { OpportunityRow } from "../../src/db/schema.js";
import {
  type OpportunityInsertData,
  fromStandard,
  organizationInserts,
  toStandard,
  toSummary,
} from "../../src/modules/mappers/opportunity.mapper.js";

const EXAMPLES_DIR = fileURLToPath(
  new URL("../../../standard/schemas/v1.0.0/examples", import.meta.url),
);

function loadExamples(): { file: string; opp: Opportunity }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, opp: JSON.parse(readFileSync(`${EXAMPLES_DIR}/${file}`, "utf8")) }));
}

/** Build a DB row equivalent to what the seed would store, to drive the read mapper. */
function rowFromInsert(opp: OpportunityInsertData): OpportunityRow {
  return {
    ...opp,
    id: 1,
    reviewStatus: "approved",
    isListed: true,
    sourceSystem: null,
    createdAt: opp.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: opp.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  } as OpportunityRow;
}

/** Recursively drop null-valued keys (the mapper omits nulls; some examples spell them out). */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/** Treat null ≡ omitted and ignore the Hub-managed timestamps. */
function omitKeys(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function normalize(o: Opportunity): Record<string, unknown> {
  const c = stripNulls(JSON.parse(JSON.stringify(o))) as Record<string, unknown>;
  return omitKeys(c, ["createdAt", "updatedAt"]);
}

describe("opportunity.mapper round-trip (Standard → row → Standard)", () => {
  const examples = loadExamples();

  it("loads the committed examples", () => {
    expect(examples.length).toBeGreaterThanOrEqual(20);
  });

  for (const { file, opp } of examples) {
    it(`reproduces ${file} through fromStandard → toStandard`, () => {
      const { opp: insert } = fromStandard(opp);
      const rebuilt = toStandard(rowFromInsert(insert));
      expect(validateOpportunity(rebuilt).valid).toBe(true);
      expect(normalize(rebuilt)).toEqual(normalize(opp));
    });
  }
});

const BASE: Opportunity = {
  specVersion: "1.0.0",
  id: "x:1",
  fundingType: "grant",
  title: "T",
  description: "D",
  status: "open",
  operatingOrganizations: [{ name: "Org", slug: "org" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: ["Optimism"],
  fundingDetails: { fundingType: "grant", recurring: true },
};

describe("read projections", () => {
  const row: OpportunityRow = rowFromInsert(fromStandard(BASE).opp);

  it("stores typeData TAG-FREE and toStandard reattaches the fundingType tag", () => {
    // The DB column carries no tag — it is derivable from `fundingType` — so the copies can
    // never disagree; the read path adds it back.
    expect(row.typeData).toEqual({ recurring: true });
    const full = toStandard(row);
    expect(full.fundingDetails).toEqual({ fundingType: "grant", recurring: true });
  });

  it("normalizes the served tag to the fundingType column even if the ingested tag disagreed", () => {
    // A tag-mismatched document is schema-invalid (the binding allOf rejects it) and the seed
    // gate refuses it; if one ever reached the mapper anyway, the stored payload is tag-free and
    // the read path re-derives the tag, so the mismatch cannot survive a round trip.
    const mismatched = {
      ...BASE,
      fundingDetails: { fundingType: "rfp", scope: "x" },
    } as unknown as Opportunity;
    const full = toStandard(rowFromInsert(fromStandard(mismatched).opp));
    expect(full.fundingDetails).toEqual({ fundingType: "grant", scope: "x" });
  });

  it("toSummary omits fundingDetails but keeps core fields", () => {
    const thin = toSummary(row) as Record<string, unknown>;
    expect(thin.fundingDetails).toBeUndefined();
    expect(thin.id).toBe("x:1");
    expect(thin.fundingType).toBe("grant");
    expect(thin.ecosystems).toEqual(["Optimism"]);
  });
});

describe("organizations (arrays with semantic order)", () => {
  const std: Opportunity = {
    ...BASE,
    operatingOrganizations: [{ name: "Operator Ltd", slug: "operator" }],
    sponsoringOrganizations: [
      { name: "Primary Sponsor", slug: "primary" },
      { name: "Co Sponsor", slug: "co-sponsor", contacts: [{ name: "Ada", role: "Steward" }] },
    ],
  };

  it("stores the arrays verbatim, preserving order and per-org contacts", () => {
    const { opp } = fromStandard(std);
    expect(opp.sponsoringOrganizations?.[0]?.name).toBe("Primary Sponsor");
    expect(opp.sponsoringOrganizations?.[1]?.contacts).toEqual([{ name: "Ada", role: "Steward" }]);
    expect(opp.operatingOrganizations).toHaveLength(1);
    const rebuilt = toStandard(rowFromInsert(opp));
    expect(rebuilt.sponsoringOrganizations).toEqual(std.sponsoringOrganizations);
    expect(rebuilt.operatingOrganizations).toEqual(std.operatingOrganizations);
  });

  it("derives orgSlugs as the UNION of operating and sponsoring slugs", () => {
    expect(fromStandard(std).opp.orgSlugs).toEqual(["operator", "primary", "co-sponsor"]);
  });

  it("dedupes orgSlugs when an org operates AND sponsors", () => {
    const both: Opportunity = {
      ...BASE,
      operatingOrganizations: [{ name: "Org", slug: "org" }],
      sponsoringOrganizations: [{ name: "Org", slug: "org" }],
    };
    expect(fromStandard(both).opp.orgSlugs).toEqual(["org"]);
  });

  it("feeds the organization directory from operators AND sponsors, deduped by slug", () => {
    expect(organizationInserts(std).map((o) => o.slug)).toEqual([
      "operator",
      "primary",
      "co-sponsor",
    ]);
  });

  it("omits sponsoringOrganizations from the Standard object when absent", () => {
    const rebuilt = toStandard(rowFromInsert(fromStandard(BASE).opp));
    expect(rebuilt.sponsoringOrganizations).toBeUndefined();
    expect(rebuilt.operatingOrganizations).toEqual(BASE.operatingOrganizations);
  });
});

describe("funding envelope (re-cut names)", () => {
  it("maps budget/allocated and no longer carries awardsToDate", () => {
    const { opp } = fromStandard({
      ...BASE,
      fundingInfo: { currency: "USD", budget: 200000, allocated: 50000, minAward: 1, maxAward: 2 },
    });
    expect(opp.budget).toBe("200000");
    expect(opp.allocated).toBe("50000");
    const rebuilt = toStandard(rowFromInsert(opp));
    expect(rebuilt.fundingInfo).toEqual({
      currency: "USD",
      budget: 200000,
      allocated: 50000,
      minAward: 1,
      maxAward: 2,
    });
    expect(rebuilt.fundingInfo).not.toHaveProperty("awardsToDate");
    expect(rebuilt.fundingInfo).not.toHaveProperty("totalBudget");
    expect(rebuilt).not.toHaveProperty("funding"); // renamed to fundingInfo
  });
});

describe("new optional blocks", () => {
  it("round-trips eligibility, prerequisites, additionalReferences, serviceAgreement and milestones", () => {
    const std: Opportunity = {
      ...BASE,
      eligibility: "Pre-seed to Series A teams. Global.",
      prerequisites: "Milestone plan and disclosures.",
      additionalReferences: "https://example.com/guidelines",
      serviceAgreement: "Rolling 12-month engagement, renewable.",
      milestones: [{ title: "M1", amount: 1000, criteria: "Ship by Q3" }],
    };
    const rebuilt = toStandard(rowFromInsert(fromStandard(std).opp));
    expect(rebuilt.eligibility).toBe(std.eligibility);
    expect(rebuilt.prerequisites).toBe(std.prerequisites);
    expect(rebuilt.additionalReferences).toBe(std.additionalReferences);
    expect(rebuilt.serviceAgreement).toBe(std.serviceAgreement);
    expect(rebuilt.milestones).toEqual(std.milestones);
  });

  it("omits them entirely when absent", () => {
    const rebuilt = toStandard(rowFromInsert(fromStandard(BASE).opp)) as Record<string, unknown>;
    for (const k of [
      "eligibility",
      "prerequisites",
      "additionalReferences",
      "serviceAgreement",
      "milestones",
    ]) {
      expect(rebuilt[k], k).toBeUndefined();
    }
  });
});

describe("source (url removed by the re-cut)", () => {
  it("never emits source.url and tolerates an empty source object", () => {
    const rebuilt = toStandard(rowFromInsert(fromStandard({ ...BASE, source: {} }).opp)) as Record<
      string,
      unknown
    >;
    expect(rebuilt.source).toBeDefined();
    expect(rebuilt.source).not.toHaveProperty("url");
  });
});

describe("nextDeadlineAt derivation on write", () => {
  const at = (d: string) => new Date(d);
  const now = at("2026-07-01T00:00:00.000Z");
  const withDeadlines = (deadlines: Opportunity["deadlines"]): Opportunity => ({
    ...BASE,
    deadlines,
  });

  it("picks the earliest FUTURE fixed deadline", () => {
    const { opp } = fromStandard(
      withDeadlines([
        { deadlineType: "fixed", date: "2026-12-01T00:00:00.000Z", label: "event end" },
        { deadlineType: "fixed", date: "2026-09-01T00:00:00.000Z", label: "application" },
      ]),
      now,
    );
    expect(opp.nextDeadlineAt).toEqual(at("2026-09-01T00:00:00.000Z"));
  });

  it("is null when every fixed deadline is in the past", () => {
    const { opp } = fromStandard(
      withDeadlines([
        { deadlineType: "fixed", date: "2026-01-01T00:00:00.000Z", label: "application" },
      ]),
      now,
    );
    expect(opp.nextDeadlineAt).toBeNull();
  });

  it("is null for a rolling-only record", () => {
    const { opp } = fromStandard(
      withDeadlines([{ deadlineType: "rolling", label: "application" }]),
      now,
    );
    expect(opp.nextDeadlineAt).toBeNull();
    expect(opp.deadlines).toHaveLength(1);
  });

  it("is null when there are no deadlines at all", () => {
    expect(fromStandard(BASE, now).opp.nextDeadlineAt).toBeNull();
    expect(fromStandard(BASE, now).opp.deadlines).toEqual([]);
  });

  it("ignores a past fixed deadline that sits alongside a future one", () => {
    const { opp } = fromStandard(
      withDeadlines([
        { deadlineType: "fixed", date: "2026-02-01T00:00:00.000Z", label: "registration" },
        { deadlineType: "rolling", label: "application" },
        { deadlineType: "fixed", date: "2026-08-01T00:00:00.000Z", label: "submission" },
      ]),
      now,
    );
    expect(opp.nextDeadlineAt).toEqual(at("2026-08-01T00:00:00.000Z"));
  });
});

describe("ingest normalization", () => {
  // A second type block became UNREPRESENTABLE with the single `fundingDetails` slot — the old
  // assertSingleTypeBlock() guard is gone because the shape it policed no longer exists. A stray
  // legacy top-level block key is simply not a Standard field and is never read or stored.
  it("ignores a stray legacy top-level type-block key", () => {
    const legacy = { ...BASE, hackathon: { online: true } } as Opportunity;
    const rebuilt = toStandard(rowFromInsert(fromStandard(legacy).opp)) as Record<string, unknown>;
    expect(rebuilt.hackathon).toBeUndefined();
    expect(rebuilt.fundingDetails).toEqual({ fundingType: "grant", recurring: true });
  });

  it("accepts and STRIPS the self-identification properties", () => {
    const selfIdentifying = {
      ...BASE,
      $schema: "https://ethrfps.app/schemas/v1.0.0/opportunity.schema.json",
      "@context": "https://ethrfps.app/schemas/v1.0.0/context.jsonld",
      "@type": "schema:Grant",
    } as Opportunity;
    const rebuilt = toStandard(rowFromInsert(fromStandard(selfIdentifying).opp)) as Record<
      string,
      unknown
    >;
    expect(rebuilt.$schema).toBeUndefined();
    expect(rebuilt["@context"]).toBeUndefined();
    expect(rebuilt["@type"]).toBeUndefined();
    expect(rebuilt.id).toBe("x:1");
  });
});
