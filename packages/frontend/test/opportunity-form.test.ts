/**
 * The form's mapping, in both directions.
 *
 * The round trip is the part worth testing: `PUT` REPLACES a stored record, so anything the edit
 * form fails to carry through is data a publisher loses by pressing Save.
 */
import { emptyForm, fromDocument, idProblem, splitList, toDocument } from "@/lib/opportunity-form";
import type { Opportunity } from "@/lib/types";
import { describe, expect, it } from "vitest";

describe("splitList", () => {
  it("trims, drops blanks and never produces an empty string entry", () => {
    expect(splitList(" ethereum , optimism ,, ")).toEqual(["ethereum", "optimism"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("idProblem", () => {
  it("requires the namespaced form the API derives the source system from", () => {
    expect(idProblem("")).toContain("required");
    expect(idProblem("no-namespace")).toContain("<namespace>:<local>");
    expect(idProblem(":leading")).toContain("<namespace>:<local>");
    expect(idProblem("trailing:")).toContain("<namespace>:<local>");
    expect(idProblem("acme-foundation:2026-round-1")).toBeNull();
  });
});

describe("toDocument", () => {
  it("omits empty optional fields rather than storing an empty string", () => {
    const form = {
      ...emptyForm(),
      id: "acme:1",
      title: "Round One",
      description: "A description.",
      orgName: "Acme Foundation",
      orgSlug: "acme",
    };
    const { document, problems } = toDocument(form);

    expect(problems).toEqual([]);
    expect(document.summary).toBeUndefined();
    expect(document.website).toBeUndefined();
    expect(document.ecosystems).toBeUndefined();
    expect(document.fundingInfo).toBeUndefined();
    expect(document.specVersion).toBe("1.0.0");
    expect(document.operatingOrganizations).toEqual([{ name: "Acme Foundation", slug: "acme" }]);
  });

  it("never sets an attribution field — the server owns every one of them", () => {
    const { document } = toDocument({ ...emptyForm(), id: "acme:1" });
    expect(document.source).toEqual({});
  });

  it("reports malformed JSON instead of submitting a broken document", () => {
    const { problems } = toDocument({ ...emptyForm(), fundingDetails: "{oops" });
    expect(problems.join(" ")).toContain("fundingDetails is not valid JSON");
  });

  it("reports a non-numeric amount", () => {
    const { problems } = toDocument({ ...emptyForm(), budget: "a lot" });
    expect(problems).toContain("budget is not a number.");
  });

  it("keeps numeric amounts numeric", () => {
    const { document } = toDocument({ ...emptyForm(), currency: "USD", budget: "50000" });
    expect(document.fundingInfo).toEqual({ currency: "USD", budget: 50000 });
  });
});

describe("fromDocument", () => {
  const stored = {
    specVersion: "1.0.0",
    id: "acme:1",
    fundingType: "grant",
    title: "Round One",
    description: "A description.",
    status: "open",
    ecosystems: ["ethereum", "optimism"],
    operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
    source: { publisher: "acme", submittedBy: "acme", submittedAt: "2026-08-01T00:00:00Z" },
    fundingDetails: { fundingType: "grant" },
    // Neither of these is rendered by the form.
    milestones: [{ title: "Ship it" }],
    socialLinks: [{ platform: "farcaster", url: "https://example.com/acme" }],
  } as unknown as Opportunity;

  it("fills the form from the stored record", () => {
    const { form } = fromDocument(stored);
    expect(form.id).toBe("acme:1");
    expect(form.ecosystems).toBe("ethereum, optimism");
    expect(form.orgSlug).toBe("acme");
    expect(JSON.parse(form.fundingDetails)).toEqual({ fundingType: "grant" });
  });

  it("carries every unmodelled field through, so a replace does not delete them", () => {
    const { carried } = fromDocument(stored);
    expect(carried.milestones).toEqual([{ title: "Ship it" }]);
    expect(carried.socialLinks).toHaveLength(1);
    expect(carried.source).toEqual(stored.source);
  });

  it("round-trips: rebuilding from the form plus the carried fields loses nothing", () => {
    const { form, carried } = fromDocument(stored);
    const rebuilt = toDocument(form, carried).document;

    expect(rebuilt.milestones).toEqual([{ title: "Ship it" }]);
    expect(rebuilt.title).toBe("Round One");
    expect(rebuilt.ecosystems).toEqual(["ethereum", "optimism"]);
    // The form's own `source` wins, and it is empty: the server sets attribution on every write.
    expect(rebuilt.source).toEqual({});
  });
});

/**
 * The round trip against an entry that uses EVERY optional member the form does not render —
 * including the ones INSIDE the two containers it half-models.
 *
 * A `PUT` replaces the stored record, so the question this answers is not "did the top level
 * survive" but "did anything at all change that the publisher did not change". The assertion is
 * therefore on the serialized bytes: an edit that touches one field must produce a payload
 * identical to the stored record except that field (and `source`, which the server owns).
 */
describe("the maximal round trip", () => {
  const maximal = {
    specVersion: "1.0.0",
    id: "acme:maximal",
    fundingType: "grant",
    title: "Round One",
    summary: "A short summary.",
    description: "A description.",
    status: "open",
    ecosystems: ["ethereum", "optimism"],
    categories: ["infrastructure", "tooling"],
    eligibility: "Teams shipping on a public network.",
    applicationUrl: "https://example.org/apply",
    website: "https://example.org",
    logoUrl: "https://example.org/logo.png",
    bannerUrl: "https://example.org/banner.png",
    socialLinks: [{ platform: "farcaster", url: "https://example.com/acme" }],
    operatingOrganizations: [
      {
        name: "Acme Foundation",
        slug: "acme",
        website: "https://acme.example",
        logoUrl: "https://acme.example/logo.png",
        contacts: [{ contactType: "email", value: "grants@acme.example" }],
        ecosystems: ["ethereum"],
      },
      // A SECOND operating organisation. Rebuilding the array from the form's two inputs deleted
      // this one outright.
      { name: "Beta Collective", slug: "beta", website: "https://beta.example" },
    ],
    sponsoringOrganizations: [{ name: "Gamma DAO", slug: "gamma" }],
    fundingInfo: {
      currency: "USD",
      budget: 500000,
      minAward: 10000,
      maxAward: 50000,
      // …and the member the form has no input for, inside a container it partly rebuilds.
      allocated: 125000,
    },
    fundingDetails: { fundingType: "grant", rounds: [{ name: "Spring", budget: 250000 }] },
    deadlines: [{ deadlineType: "fixed", date: "2026-12-01T00:00:00.000Z", label: "application" }],
    milestones: [{ title: "Ship it", description: "A working prototype." }],
    prerequisites: ["A public repository."],
    additionalReferences: [{ label: "Guidelines", url: "https://example.org/guidelines" }],
    serviceAgreement: "https://example.org/terms",
    opensAt: "2026-09-01T00:00:00.000Z",
    postedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    source: { publisher: "acme", submittedBy: "acme", submittedAt: "2026-08-01T00:00:00.000Z" },
  } as unknown as Opportunity;

  /** What the server would receive, as the client would serialize it. */
  const payload = (over: Partial<Record<string, unknown>> = {}) =>
    JSON.stringify({ ...(maximal as unknown as Record<string, unknown>), ...over });

  it("produces a byte-identical payload when nothing is edited", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument(form, carried);

    expect(rebuilt.problems).toEqual([]);
    // `source` is the ONE deliberate difference: the server owns attribution and the client sends
    // an empty object rather than echoing what it was told.
    expect(JSON.stringify(rebuilt.document)).toBe(payload({ source: {} }));
  });

  it("changes exactly the edited field and nothing else", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument({ ...form, title: "Round Two" }, carried);

    expect(JSON.stringify(rebuilt.document)).toBe(payload({ title: "Round Two", source: {} }));
  });

  it("keeps every member of a container it only partly renders", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument({ ...form, budget: "600000", orgName: "Acme" }, carried);
    const document = rebuilt.document as Record<string, unknown>;

    // The first organisation's OTHER members survive an edit to its name…
    expect(document.operatingOrganizations).toEqual([
      {
        name: "Acme",
        slug: "acme",
        website: "https://acme.example",
        logoUrl: "https://acme.example/logo.png",
        contacts: [{ contactType: "email", value: "grants@acme.example" }],
        ecosystems: ["ethereum"],
      },
      { name: "Beta Collective", slug: "beta", website: "https://beta.example" },
    ]);
    // …and `allocated` survives an edit to the budget.
    expect(document.fundingInfo).toEqual({
      currency: "USD",
      budget: 600000,
      minAward: 10000,
      maxAward: 50000,
      allocated: 125000,
    });
  });

  it("removes a field the publisher actually cleared", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument({ ...form, summary: "", maxAward: "" }, carried);
    const document = rebuilt.document as Record<string, unknown>;

    expect("summary" in document).toBe(false);
    expect(document.fundingInfo).toEqual({
      currency: "USD",
      budget: 500000,
      minAward: 10000,
      allocated: 125000,
    });
  });
});
