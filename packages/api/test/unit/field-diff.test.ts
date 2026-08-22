/**
 * THE VERIFICATION DIFF.
 *
 * Every check here is a presence test whose result a reviewer reads. The cases that matter are the
 * ones where a naive implementation reports a correct page as wrong: a title that carries the
 * site's furniture as well as the programme's name, a deadline published as "1 March 2026" rather
 * than as an ISO string, and an award written "$50,000" against a stored `50000`.
 *
 * And the boundary that has to stay where it is: `matched` is a LOW BAR — the page exists and is
 * about this programme. It is an anti-spam signal, not a fact-check, and nothing here claims the
 * amounts or dates are correct.
 */
import { describe, expect, it } from "vitest";
import {
  TITLE_MATCH_THRESHOLD,
  amountForms,
  dateForms,
  fieldDiff,
  isMatched,
  jaccard,
  offDomainRedirect,
  tokenize,
} from "../../src/modules/shared/field-diff.js";

const URLS = { requested: "https://example.org/grants", final: "https://example.org/grants" };

const record = {
  title: "Ecosystem Grants Round 5",
  deadlines: [{ deadlineType: "fixed", date: "2026-03-01T00:00:00Z" }, { deadlineType: "rolling" }],
  minAward: 5000,
  maxAward: 50000,
  operatingOrganizations: [{ name: "Example Foundation" }],
};

describe("tokenize and jaccard", () => {
  // Function words only. A longer, domain-aware stop list ("grant", "round", "programme") is what
  // a search ranker comparing DIFFERENT records would want; here the two sides are one record and
  // the page it points at, so those words are most of the shared evidence that they match.
  it("drops English function words and keeps the domain words that carry the identity", () => {
    expect([...tokenize("The Grant Program for Ecosystems")]).toEqual([
      "grant",
      "program",
      "ecosystems",
    ]);
  });

  // Set overlap rather than edit distance: a page title is the record's title plus furniture.
  it("scores a title carrying the site's furniture as the same programme", () => {
    const score = jaccard(
      tokenize("Ecosystem Grants Round 5"),
      tokenize("Ecosystem Grants Round 5 | Example Foundation"),
    );
    expect(score).toBeGreaterThan(TITLE_MATCH_THRESHOLD);
  });

  it("scores an unrelated programme low", () => {
    expect(
      jaccard(tokenize("Ecosystem Grants Round 5"), tokenize("Security Audit Bounty Programme")),
    ).toBeLessThan(TITLE_MATCH_THRESHOLD);
  });

  // No evidence is not agreement.
  it("is 0 when either side is empty", () => {
    expect(jaccard(new Set(), tokenize("anything"))).toBe(0);
  });
});

describe("dateForms", () => {
  // Testing one form would report almost every real page as missing its own deadline.
  it("covers ISO, both slash orders and both written orders", () => {
    const forms = dateForms("2026-03-01T00:00:00Z");
    expect(forms).toContain("2026-03-01");
    expect(forms).toContain("03/01/2026");
    expect(forms).toContain("01/03/2026");
    expect(forms).toContain("march 1, 2026");
    expect(forms).toContain("1 march 2026");
  });

  it("returns nothing for an unparseable date rather than throwing", () => {
    expect(dateForms("the thirty-second of may")).toEqual([]);
  });
});

describe("amountForms", () => {
  it("covers bare and thousands-grouped forms", () => {
    expect(amountForms(50000)).toEqual(["50000", "50,000"]);
    expect(amountForms(500)).toEqual(["500"]);
  });
});

describe("offDomainRedirect", () => {
  // A flag, never a rejection: a foundation legitimately redirects to its grants platform, and a
  // dead programme legitimately redirects to a homepage. Only a reviewer can tell those apart.
  it("is undefined for a same-site redirect, including across subdomains", () => {
    expect(
      offDomainRedirect("https://grants.example.org/x", "https://www.example.org/y"),
    ).toBeUndefined();
  });

  it("reports a redirect that left the site", () => {
    expect(offDomainRedirect("https://example.org/x", "https://elsewhere.test/y")).toEqual({
      from: "example.org",
      to: "elsewhere.test",
    });
  });
});

describe("fieldDiff", () => {
  const page = {
    title: "Ecosystem Grants Round 5 | Example Foundation",
    text: "Applications for the Example Foundation ecosystem grants close on 1 March 2026. Awards range from $5,000 to $50,000.",
  };

  it("matches the title and finds each stated fact, naming the form that matched", () => {
    const diff = fieldDiff(record, page, URLS);
    expect(diff.title.matched).toBe(true);
    expect(diff.title.similarity).toBeGreaterThan(TITLE_MATCH_THRESHOLD);

    expect(diff.deadlines).toHaveLength(1); // the rolling entry has no date to look for
    expect(diff.deadlines[0]).toMatchObject({ found: true, matchedAs: "1 march 2026" });

    expect(diff.amounts.map((a) => a.found)).toEqual([true, true]);
    expect(diff.amounts[0]?.matchedAs).toBe("5,000");
    expect(diff.organization).toMatchObject({ value: "Example Foundation", found: true });
    expect(diff.offDomainRedirect).toBeUndefined();
  });

  // The haystack deliberately includes the title as well as the body — a page often states the
  // organization only in its title — so a page that corroborates nothing has to say nothing in
  // either place.
  it("records a fact the page does not corroborate as not found, without failing", () => {
    const diff = fieldDiff(record, { title: "Grants", text: "Applications are open." }, URLS);
    expect(diff.deadlines[0]?.found).toBe(false);
    expect(diff.amounts.every((a) => !a.found)).toBe(true);
    expect(diff.organization?.found).toBe(false);
  });

  it("scores an unrelated page as not matching", () => {
    const diff = fieldDiff(record, { title: "Security Audit Bounty", text: "Report bugs." }, URLS);
    expect(diff.title.matched).toBe(false);
  });

  it("flags a redirect that left the site", () => {
    const diff = fieldDiff(record, page, {
      requested: "https://example.org/grants",
      final: "https://link-shortener.test/abc",
    });
    expect(diff.offDomainRedirect).toEqual({ from: "example.org", to: "link-shortener.test" });
  });
});

describe("isMatched", () => {
  // The low bar, and both halves of it.
  it("requires the page to exist AND the title to be about this programme", () => {
    const good = fieldDiff(record, { title: "Ecosystem Grants Round 5", text: "x" }, URLS);
    const bad = fieldDiff(record, { title: "Something Else Entirely", text: "x" }, URLS);
    expect(isMatched(true, good)).toBe(true);
    expect(isMatched(false, good)).toBe(false);
    expect(isMatched(true, bad)).toBe(false);
  });
});
