/**
 * Field-fidelity tests for the mapper: the fields it used to fabricate, and the ones it used to
 * drop on the floor. The rest of the mapper's contract (the pre-re-cut → re-cut conversion) lives
 * in map-program.test.ts; this file is about publishing what the upstream ACTUALLY says.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import { type RegistryProgram, mapProgram, sponsorNamesOf } from "../../scripts/map-program.js";
import {
  grantProgram,
  hackathonProgram,
  multiOrgProgram,
  rfpProgram,
  unnamedSponsorProgram,
} from "../fixtures/upstream-programs.js";

const BASE = "https://example.org/programs";

describe("sponsoring organizations", () => {
  it("publishes the organisations the upstream names, in upstream order", () => {
    const o = mapProgram(multiOrgProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.sponsoringOrganizations.map((s) => s.name)).toEqual([
      "Solana Foundation",
      "Colosseum",
    ]);
    // and never the program title, which is what the fallback used to fabricate
    expect(o.sponsoringOrganizations.map((s) => s.name)).not.toContain(o.title);
  });

  it("identifies a named organisation by its own slug, not by the community's", () => {
    const o = mapProgram(multiOrgProgram, { programUrlBase: BASE });
    expect(o.sponsoringOrganizations.map((s) => s.slug)).toEqual([
      "solana-foundation",
      "colosseum",
    ]);
    // the community is the ecosystem, and stays the provenance publisher
    expect(o.source.publisher).toBe("solana");
  });

  it("gives only the primary organisation the program's branding", () => {
    const [primary, coSponsor] = mapProgram(multiOrgProgram, {
      programUrlBase: BASE,
    }).sponsoringOrganizations;
    expect(primary?.website).toBe("https://foundation.example.org");
    expect(coSponsor).toEqual({ name: "Colosseum", slug: "colosseum" });
  });

  it("falls back to the listing community when no organisation is genuinely named", () => {
    const o = mapProgram(unnamedSponsorProgram, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.sponsoringOrganizations).toHaveLength(1);
    // a real, lookup-able organisation — not the program title, which is not an organisation
    expect(o.sponsoringOrganizations[0]).toMatchObject({ name: "Base", slug: "base" });
    expect(o.sponsoringOrganizations[0]?.name).not.toBe(o.title);
  });

  // The regression this exists for: a title-derived NAME filed under the COMMUNITY's slug. Several
  // programs of one community then collapse onto a single directory row named after whichever
  // fabricated sponsor was written last, and `?organization=<slug>` conflates them.
  it("gives a title fallback its own slug, never the community's", () => {
    const noCommunity = { ...unnamedSponsorProgram, communities: [] };
    const o = mapProgram(noCommunity, { programUrlBase: BASE });
    expect(validateOpportunity(o).valid).toBe(true);
    expect(o.sponsoringOrganizations[0]).toMatchObject({
      name: "Anonymous Builders Round",
      slug: "anonymous-builders-round",
    });

    const sibling = mapProgram(
      {
        ...noCommunity,
        programId: "2052",
        metadata: { ...noCommunity.metadata, title: "Anonymous Builders Round 2" },
      },
      { programUrlBase: BASE },
    );
    expect(sibling.sponsoringOrganizations[0]?.slug).not.toBe(o.sponsoringOrganizations[0]?.slug);
  });

  it("lets rfp.issuingOrganization take the primary slot", () => {
    const o = mapProgram(
      { ...rfpProgram, metadata: { ...rfpProgram.metadata, organizations: ["Matter Labs"] } },
      { programUrlBase: BASE },
    );
    expect(o.sponsoringOrganizations.map((s) => s.name)).toEqual([
      "ZKsync Foundation",
      "Matter Labs",
    ]);
  });

  describe("sponsorNamesOf", () => {
    const fallbacks = { title: "A Program" };

    it("dedupes case-insensitively and reports where the names came from", () => {
      expect(sponsorNamesOf(["Acme", "acme ", "Beta"], undefined, fallbacks)).toEqual({
        names: ["Acme", "Beta"],
        source: "upstream",
      });
    });

    it("treats an empty or non-array organizations field as absent", () => {
      for (const organizations of [undefined, [], ["", "  "], "Acme", 7]) {
        expect(sponsorNamesOf(organizations, undefined, fallbacks)).toEqual({
          names: ["A Program"],
          source: "title",
        });
        expect(
          sponsorNamesOf(organizations, undefined, { ...fallbacks, community: "Base" }),
        ).toEqual({ names: ["Base"], source: "community" });
      }
    });

    it("caps a name at the Standard's 256 characters", () => {
      const { names } = sponsorNamesOf(["x".repeat(400)], undefined, fallbacks);
      expect(names[0]).toHaveLength(256);
    });
  });
});

/**
 * The fallback is not a rare path — most upstream programs name no organisation at all — so it is
 * measured against the whole frozen corpus rather than a single hand-built fixture.
 */
describe("sponsoring organizations across the frozen corpus", () => {
  const corpus = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-corpus.json", import.meta.url)), "utf8"),
  ) as { programs: RegistryProgram[] };
  const mapped = corpus.programs.map((p) => mapProgram(p, { sourceSystem: "fundingmap" }));

  it("never lets two different organisation names share one directory slug", () => {
    const namesBySlug = new Map<string, Set<string>>();
    for (const o of mapped) {
      for (const org of o.sponsoringOrganizations) {
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
    const fabricated = mapped.filter((o) => o.sponsoringOrganizations[0]?.name === o.title);
    for (const o of fabricated) {
      const p = corpus.programs.find((raw) => `fundingmap:${raw.programId ?? raw.id}` === o.id);
      expect(p?.metadata?.organizations ?? [], o.id).toEqual([]);
      expect(p?.communities?.[0]?.name, o.id).toBeUndefined();
    }
    expect(fabricated.length).toBeLessThan(mapped.length);
  });
});

describe("fields the upstream provides that used to be dropped", () => {
  const o = mapProgram(multiOrgProgram, { programUrlBase: BASE });

  it("maps committed-to-date into the funding envelope, ignoring the upstream's 0 default", () => {
    expect(o.funding?.allocated).toBe(125000);
    expect(mapProgram(unnamedSponsorProgram).funding?.allocated).toBeUndefined();
  });

  it("maps the applicant flag into eligibility, in both directions", () => {
    expect(o.eligibility?.openTo).toMatch(/^Anyone may apply/);
    expect(mapProgram(unnamedSponsorProgram).eligibility?.openTo).toMatch(/^Not open to all/);
    expect(mapProgram(grantProgram).eligibility).toBeUndefined(); // flag absent ⇒ no claim
  });

  it("keeps a program page that applicationUrl has no room for", () => {
    expect(o.applicationUrl).toBe("https://apply.example.org/frontier");
    expect(o.resourceLinks).toBe("Program site: https://example.org/frontier-round");
    // when the program page IS the applicationUrl there is nothing left over to record
    expect(mapProgram(grantProgram).resourceLinks).toBeUndefined();
  });

  it("dates the entry from when the source first listed it", () => {
    expect(o.postedAt).toBe("2026-01-05T10:00:00.000Z");
  });

  it("parks upstream data with no Standard home under a namespaced extensions key", () => {
    expect(o.extensions).toEqual({ "fundingmap.grantsToDate": 12, "fundingmap.chainId": "42161" });
    expect(mapProgram(multiOrgProgram, { sourceSystem: "acme" }).extensions).toHaveProperty(
      "acme.grantsToDate",
    );
    // a zero award count is the upstream's default, not a fact about the program
    expect(mapProgram(unnamedSponsorProgram).extensions).toBeUndefined();
  });

  it("reads 'online' out of a location that says so in words", () => {
    expect(mapProgram(hackathonProgram, { programUrlBase: BASE }).hackathon?.online).toBe(true);
    expect(mapProgram(grantProgram).grant).not.toHaveProperty("online");
  });

  it("stamps the spec version the package exports rather than a literal", () => {
    expect(o.specVersion).toBe(SPEC_VERSION);
  });
});
