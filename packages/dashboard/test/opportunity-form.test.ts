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
    const rebuilt = { ...carried, ...toDocument(form).document };

    expect(rebuilt.milestones).toEqual([{ title: "Ship it" }]);
    expect(rebuilt.title).toBe("Round One");
    expect(rebuilt.ecosystems).toEqual(["ethereum", "optimism"]);
    // The form's own `source` wins, and it is empty: the server sets attribution on every write.
    expect(rebuilt.source).toEqual({});
  });
});
