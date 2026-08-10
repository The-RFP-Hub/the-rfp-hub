/**
 * Field-fidelity tests for the mapper: the fields it used to fabricate, and the ones it used to
 * drop on the floor. The rest of the mapper's contract (the pre-re-cut → re-cut conversion) lives
 * in map-program.test.ts; this file is about publishing what the upstream ACTUALLY says — and,
 * since the re-cut, about the handful of things it says that the closed core cannot carry.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import {
  type RegistryProgram,
  mapProgram,
  organizationNamesOf,
} from "../../scripts/map-program.js";
import {
  grantProgram,
  hackathonProgram,
  multiOrgProgram,
  rfpProgram,
  unnamedOrgProgram,
} from "../fixtures/upstream-programs.js";

/**
 * The re-cut split organisations into two roles. The upstream publishes one flat list of the
 * organisations behind a program, and those organisations RUN it — so they fill the required
 * `operatingOrganizations`, and `sponsoringOrganizations` stays absent rather than being filled
 * with the same names or with the listing community.
 */
describe("operating organizations", () => {
  it("publishes the organisations the upstream names, in upstream order", () => {
    const o = mapProgram(multiOrgProgram);
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.operatingOrganizations.map((s) => s.name)).toEqual(["Solana Foundation", "Colosseum"]);
    // and never the program title, which is what the fallback used to fabricate
    expect(o.operatingOrganizations.map((s) => s.name)).not.toContain(o.title);
  });

  // The upstream names no backer distinct from the operator, so the Standard's answer is "no
  // entry" — not the same names under a second role, and not the listing community, which lists
  // the program without necessarily funding it.
  it("never invents a sponsoring organization the upstream did not publish", () => {
    for (const p of [multiOrgProgram, unnamedOrgProgram, grantProgram, rfpProgram]) {
      expect(mapProgram(p)).not.toHaveProperty("sponsoringOrganizations");
    }
  });

  it("identifies a named organisation by its own slug, not by the community's", () => {
    const o = mapProgram(multiOrgProgram);
    expect(o.operatingOrganizations.map((s) => s.slug)).toEqual(["solana-foundation", "colosseum"]);
    // the community is the ecosystem, and stays the provenance publisher
    expect(o.source.publisher).toBe("solana");
  });

  it("gives only the primary organisation the program's branding", () => {
    const [primary, coOperator] = mapProgram(multiOrgProgram).operatingOrganizations;
    expect(primary?.website).toBe("https://foundation.example.org");
    expect(coOperator).toEqual({ name: "Colosseum", slug: "colosseum" });
  });

  it("falls back to the listing community when no organisation is genuinely named", () => {
    const o = mapProgram(unnamedOrgProgram);
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.operatingOrganizations).toHaveLength(1);
    // a real, lookup-able organisation — not the program title, which is not an organisation
    expect(o.operatingOrganizations[0]).toMatchObject({ name: "Base", slug: "base" });
    expect(o.operatingOrganizations[0]?.name).not.toBe(o.title);
  });

  // The regression this exists for: a title-derived NAME filed under the COMMUNITY's slug. Several
  // programs of one community then collapse onto a single directory row named after whichever
  // fabricated organisation was written last, and `?organization=<slug>` conflates them.
  it("gives a title fallback its own slug, never the community's", () => {
    const noCommunity = { ...unnamedOrgProgram, communities: [] };
    const o = mapProgram(noCommunity);
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.operatingOrganizations[0]).toMatchObject({
      name: "Anonymous Builders Round",
      slug: "anonymous-builders-round",
    });

    const sibling = mapProgram({
      ...noCommunity,
      programId: "2052",
      metadata: { ...noCommunity.metadata, title: "Anonymous Builders Round 2" },
    });
    expect(sibling.operatingOrganizations[0]?.slug).not.toBe(o.operatingOrganizations[0]?.slug);
  });

  it("lets rfp.issuingOrganization take the primary slot", () => {
    const o = mapProgram({
      ...rfpProgram,
      metadata: { ...rfpProgram.metadata, organizations: ["Matter Labs"] },
    });
    expect(o.operatingOrganizations.map((s) => s.name)).toEqual([
      "ZKsync Foundation",
      "Matter Labs",
    ]);
  });

  describe("organizationNamesOf", () => {
    const fallbacks = { title: "A Program" };

    it("dedupes case-insensitively and reports where the names came from", () => {
      expect(organizationNamesOf(["Acme", "acme ", "Beta"], undefined, fallbacks)).toEqual({
        names: ["Acme", "Beta"],
        source: "upstream",
      });
    });

    it("treats an empty or non-array organizations field as absent", () => {
      for (const organizations of [undefined, [], ["", "  "], "Acme", 7]) {
        expect(organizationNamesOf(organizations, undefined, fallbacks)).toEqual({
          names: ["A Program"],
          source: "title",
        });
        expect(
          organizationNamesOf(organizations, undefined, { ...fallbacks, community: "Base" }),
        ).toEqual({ names: ["Base"], source: "community" });
      }
    });

    it("caps a name at the Standard's 256 characters", () => {
      const { names } = organizationNamesOf(["x".repeat(400)], undefined, fallbacks);
      expect(names[0]).toHaveLength(256);
    });
  });
});

/**
 * The fallback is not a rare path — most upstream programs name no organisation at all — so it is
 * measured against the whole frozen corpus rather than a single hand-built fixture.
 */
describe("operating organizations across the frozen corpus", () => {
  const corpus = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-corpus.json", import.meta.url)), "utf8"),
  ) as { programs: RegistryProgram[] };
  const mapped = corpus.programs.map((p) => mapProgram(p, { sourceSystem: "fundingmap" }));

  it("never lets two different organisation names share one directory slug", () => {
    const namesBySlug = new Map<string, Set<string>>();
    for (const o of mapped) {
      for (const org of o.operatingOrganizations) {
        // the mapper always emits a slug; the Standard leaves it optional
        const slug = org.slug ?? `(no slug for ${org.name})`;
        const names = namesBySlug.get(slug) ?? new Set<string>();
        names.add(org.name);
        namesBySlug.set(slug, names);
      }
    }
    const conflated = [...namesBySlug].filter(([, names]) => names.size > 1);
    expect(conflated.map(([slug, names]) => `${slug}: ${[...names].join(" | ")}`)).toEqual([]);
  });

  it("publishes a real organisation whenever the upstream gives it one", () => {
    // The title fallback only fires where the upstream names neither an organisation nor a
    // listing community — never where either is available.
    const fabricated = mapped.filter((o) => o.operatingOrganizations[0]?.name === o.title);
    for (const o of fabricated) {
      const p = corpus.programs.find((raw) => `fundingmap:${raw.programId ?? raw.id}` === o.id);
      expect(p?.metadata?.organizations ?? [], o.id).toEqual([]);
      expect(p?.communities?.[0]?.name, o.id).toBeUndefined();
    }
    expect(fabricated.length).toBeLessThan(mapped.length);
  });
});

describe("fields the upstream provides that used to be dropped", () => {
  const o = mapProgram(multiOrgProgram);

  it("maps committed-to-date into the funding envelope, ignoring the upstream's 0 default", () => {
    expect(o.fundingInfo?.allocated).toBe(125000);
    expect(mapProgram(unnamedOrgProgram).fundingInfo?.allocated).toBeUndefined();
  });

  // The re-cut turned `eligibility` from an open key-value map into one free-text string, so the
  // upstream's single signal becomes the whole sentence rather than an `openTo` key.
  it("maps the applicant flag into free-text eligibility, in both directions", () => {
    expect(o.eligibility).toMatch(/^Anyone may apply/);
    expect(mapProgram(unnamedOrgProgram).eligibility).toMatch(/^Not open to all/);
    expect(mapProgram(grantProgram).eligibility).toBeUndefined(); // flag absent ⇒ no claim
  });

  it("keeps a program page that applicationUrl has no room for", () => {
    expect(o.applicationUrl).toBe("https://apply.example.org/frontier");
    // `resourceLinks` became `additionalReferences` in the re-cut — same one free-form string
    expect(o.additionalReferences).toBe("Program site: https://example.org/frontier-round");
    // when the program page IS the applicationUrl there is nothing left over to record
    expect(mapProgram(grantProgram).additionalReferences).toBeUndefined();
  });

  it("dates the entry from when the source first listed it", () => {
    expect(o.postedAt).toBe("2026-01-05T10:00:00.000Z");
  });

  it("reads 'online' out of a location that says so in words", () => {
    const hackathon = mapProgram(hackathonProgram).fundingDetails;
    expect(hackathon).toMatchObject({ fundingType: "hackathon", online: true });
    expect(mapProgram(grantProgram).fundingDetails).not.toHaveProperty("online");
  });

  it("stamps the spec version the package exports rather than a literal", () => {
    expect(o.specVersion).toBe(SPEC_VERSION);
  });
});

/**
 * What the CLOSED CORE forced out. `additionalProperties: false` at the top level with no
 * `extensions` escape hatch means these are losses, and a loss is worth a test so it stays a
 * decision rather than becoming a surprise.
 */
describe("what the closed core cannot carry", () => {
  const o = mapProgram(multiOrgProgram);

  it("emits no extensions block, and no key outside the Standard's own vocabulary", () => {
    expect(o).not.toHaveProperty("extensions");
    // grantsToDate (an award COUNT) has no field and is not derivable from fundingInfo.allocated
    expect(JSON.stringify(o)).not.toContain("grantsToDate");
    expect(validateOpportunity(o).valid).toBe(true); // additionalProperties:false would say so too
  });

  it("drops the removed networks/tags axes rather than smuggling them elsewhere", () => {
    const withRemovedAxes = mapProgram({
      ...multiOrgProgram,
      metadata: {
        ...multiOrgProgram.metadata,
        title: "Frontier Builders Round",
        categories: ["Public Goods"],
        networks: ["arbitrum"],
        grantTypes: ["retroactive"],
      },
    });
    expect(validateOpportunity(withRemovedAxes).valid).toBe(true);
    expect(withRemovedAxes).not.toHaveProperty("networks");
    expect(withRemovedAxes).not.toHaveProperty("tags");
    expect(withRemovedAxes.categories).toEqual(["Public Goods"]); // the surviving axis
  });
});

/** The re-cut requires a trailing 'Z' on every timestamp field — `pattern: "Z$"`. */
describe("timestamps are UTC", () => {
  const TIMESTAMP_FIELDS = ["opensAt", "postedAt", "createdAt", "updatedAt"] as const;

  it("converts a local-offset upstream timestamp to the same instant in UTC", () => {
    // the fixture's createdAt is 07:00-03:00 — converted, not relabelled as 07:00Z
    const o = mapProgram(multiOrgProgram);
    expect(o.createdAt).toBe("2026-01-05T10:00:00.000Z");
    expect(o.postedAt).toBe("2026-01-05T10:00:00.000Z");
    expect(validateOpportunity(o).valid).toBe(true);
  });

  it("stamps every timestamp field and deadline with a trailing Z, for every recorded shape", () => {
    // the same instant, written with a +05:30 wall clock instead of a 'Z' one
    const offset = (iso: string): string =>
      `${new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().replace("Z", "")}+05:30`;
    const shifted: RegistryProgram = {
      ...hackathonProgram,
      deadline: offset("2026-06-20T18:29:00.000Z"),
      createdAt: offset("2026-01-01T00:00:00.000Z"),
      updatedAt: offset("2026-02-01T00:00:00.000Z"),
      metadata: { ...hackathonProgram.metadata, startsAt: offset("2026-05-01T00:00:00.000Z") },
      hackathonMetadata: {
        ...hackathonProgram.hackathonMetadata,
        startDate: offset("2026-06-01T18:29:00.000Z"),
      },
    };
    const o = mapProgram(shifted);
    expect(validateOpportunity(o).valid).toBe(true);
    for (const field of TIMESTAMP_FIELDS) {
      if (o[field] != null) expect(o[field], field).toMatch(/Z$/);
    }
    for (const d of o.deadlines ?? []) expect(d.date).toMatch(/Z$/);
    // and the instants survive the conversion
    expect(o.opensAt).toBe("2026-05-01T00:00:00.000Z");
  });
});
