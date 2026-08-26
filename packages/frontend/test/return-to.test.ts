/**
 * THE RETURN PARAMETER IS ATTACKER-CONTROLLED, and that is the whole reason this module exists.
 *
 * Anyone can send anyone a link to `/listings/x?back=<anything>`. Rendered without checking, that is
 * an open redirect wearing this application's own chrome: a "← Back to your listings" control that
 * navigates somewhere else entirely. The rejections below are ordered by how often each one is
 * forgotten, and `//evil.example` is first because it starts with `/` and defeats the obvious check.
 */
import {
  detailHref,
  isSafeReturnPath,
  parseReturnLink,
  returnLabel,
  returnParams,
} from "@/lib/return-to";
import { describe, expect, it } from "vitest";

describe("what may be returned to", () => {
  it("accepts a path under a route this application has", () => {
    expect(isSafeReturnPath("/review")).toBe(true);
    expect(isSafeReturnPath("/review?tab=claims")).toBe(true);
    expect(isSafeReturnPath("/organizations/filecoin")).toBe(true);
    expect(isSafeReturnPath("/organisations/filecoin")).toBe(true);
    expect(isSafeReturnPath("/listings")).toBe(true);
    expect(isSafeReturnPath("/duplicates")).toBe(true);
  });

  it("refuses anything that leaves this origin", () => {
    // The one that defeats a naive `startsWith("/")`: protocol-relative, and a different host.
    expect(isSafeReturnPath("//evil.example/phish")).toBe(false);
    // The same thing spelled with a backslash, which some URL parsers normalise to a slash.
    expect(isSafeReturnPath("/\\evil.example")).toBe(false);
    expect(isSafeReturnPath("https://evil.example")).toBe(false);
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false);
    expect(isSafeReturnPath("")).toBe(false);
  });

  it("refuses a path that is merely PREFIXED by one of ours", () => {
    // `/listingsevil` shares five characters with a route we own and is not it.
    expect(isSafeReturnPath("/listingsevil")).toBe(false);
    expect(isSafeReturnPath("/reviewer-trap")).toBe(false);
  });

  it("refuses routes outside the allowlist, including our own public ones", () => {
    // Not a security boundary so much as a scope one: nothing navigates "back" to these.
    expect(isSafeReturnPath("/")).toBe(false);
    expect(isSafeReturnPath("/opportunities/acme:1")).toBe(false);
    expect(isSafeReturnPath("/auth/complete")).toBe(false);
  });

  it("refuses a malformed percent-escape, which would otherwise throw during render", () => {
    /*
     * `/organizations/%E0%A4%A` is a relative path under a route we own, so every other check here
     * passes it — and then `decodeURIComponent` THROWS while the label is being derived, i.e. inside
     * a render, from a parameter any stranger can put in a link. An attacker-controlled crash.
     */
    expect(isSafeReturnPath("/organizations/%E0%A4%A")).toBe(false);
    expect(isSafeReturnPath("/organizations/%")).toBe(false);
    expect(isSafeReturnPath("/review?tab=%ZZ")).toBe(false);
    expect(parseReturnLink("/organizations/%E0%A4%A")).toBeNull();
  });

  it("never throws for any input, however hostile", () => {
    for (const hostile of ["/organizations/%E0%A4%A", "%", "/%%%", "/listings/%C0"]) {
      expect(() => isSafeReturnPath(hostile)).not.toThrow();
      expect(() => parseReturnLink(hostile)).not.toThrow();
      expect(() => returnLabel(hostile)).not.toThrow();
    }
  });

  it("refuses control characters, which can truncate or smuggle past a later parser", () => {
    expect(isSafeReturnPath("/review\u0000")).toBe(false);
    expect(isSafeReturnPath("/review\nSet-Cookie: x")).toBe(false);
  });
});

describe("what the link is called", () => {
  it("names the review queue by the tab it came from", () => {
    expect(returnLabel("/review")).toBe("the review queue");
    expect(returnLabel("/review?tab=claims")).toBe("the claims queue");
    expect(returnLabel("/review?tab=duplicates")).toBe("the duplicate queue");
    expect(returnLabel("/review?tab=organizations")).toBe("organizations");
    expect(returnLabel("/review?tab=organisations")).toBe("organizations");
  });

  it("prefers an organization's supplied name over its slug", () => {
    expect(returnLabel("/organizations/filecoin", "Filecoin Foundation")).toBe(
      "Filecoin Foundation",
    );
    expect(returnLabel("/organizations/filecoin")).toBe("filecoin");
    expect(returnLabel("/organisations/filecoin", "Filecoin Foundation")).toBe(
      "Filecoin Foundation",
    );
  });

  it("caps a supplied label, because a publisher's name has no length limit and a nav does", () => {
    expect(returnLabel("/organizations/x", "n".repeat(500))).toHaveLength(60);
  });

  it("ignores a supplied label anywhere the path already says what the place is", () => {
    // Attacker-controlled text is accepted for exactly one case; everywhere else it is derived.
    expect(returnLabel("/review", "Your Bank Login")).toBe("the review queue");
    expect(returnLabel("/listings", "Your Bank Login")).toBe("your listings");
  });
});

describe("the round trip", () => {
  it("carries the origin's own query state, which is the point", () => {
    const href = detailHref("/listings", "acme:1", "/review?tab=claims");
    const back = new URL(href, "https://x.example").searchParams.get("back");

    expect(back).toBe("/review?tab=claims");
    expect(parseReturnLink(back)).toEqual({
      href: "/review?tab=claims",
      label: "the claims queue",
    });
  });

  it("percent-encodes the id and the parameter so neither can break the other", () => {
    const href = detailHref("/listings", "acme:round 1", "/organizations/filecoin", "Filecoin");
    const url = new URL(href, "https://x.example");

    expect(url.pathname).toBe("/listings/acme%3Around%201");
    expect(url.searchParams.get("back")).toBe("/organizations/filecoin");
    expect(url.searchParams.get("backLabel")).toBe("Filecoin");
  });

  it("emits no parameter at all for an origin that would not be honoured", () => {
    expect(returnParams("https://evil.example")).toBe("");
    expect(detailHref("/listings", "acme:1", "//evil.example")).toBe("/listings/acme%3A1");
  });

  it("sends a label only for an organization, matching what the reader will consent to", () => {
    expect(returnParams("/review", "Something Else")).toBe("back=%2Freview");
  });

  it("drops a malicious or absent parameter rather than rendering a link", () => {
    expect(parseReturnLink("//evil.example")).toBeNull();
    expect(parseReturnLink("https://evil.example")).toBeNull();
    expect(parseReturnLink(null)).toBeNull();
    expect(parseReturnLink(undefined)).toBeNull();
    expect(parseReturnLink("")).toBeNull();
  });
});
