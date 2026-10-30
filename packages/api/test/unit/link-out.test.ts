/**
 * The link-out vouching rule, as pure functions: the reason precedence the frontend's leaving page
 * is built against, the leaving page's URL, what a reviewer's pin writes, and the source check's
 * "did the landing move" comparison.
 *
 * The database half — who pins, and what each writer leaves alone — is
 * `test/integration/link-out.test.ts`. Everything here is the part of the contract that can be
 * exhausted without one.
 */
import { describe, expect, it } from "vitest";
import { landingMove } from "../../src/modules/services/verification/verification.service.js";
import {
  type LinkOutFacts,
  leavingPageUrl,
  leavingReason,
  reviewerPins,
} from "../../src/modules/shared/link-out.js";

const URL_A = "https://apply.example.org/form";
const URL_B = "https://apply.example.org/other-form";

const vouched: LinkOutFacts = {
  stored: URL_A,
  reviewed: URL_A,
  status: "open",
  landingChangedAt: null,
};

describe("leavingReason", () => {
  it("goes straight through for the exact link a reviewer vouched for", () => {
    expect(leavingReason("apply", vouched)).toBeNull();
    expect(leavingReason("source", vouched)).toBeNull();
    expect(leavingReason("apply", { ...vouched, status: "upcoming" })).toBeNull();
  });

  it("answers `closed` for closed and archived entries, ahead of every other reason", () => {
    for (const status of ["closed", "archived"] as const) {
      expect(leavingReason("apply", { ...vouched, status })).toBe("closed");
      expect(leavingReason("source", { ...vouched, status })).toBe("closed");
      expect(
        leavingReason("apply", {
          ...vouched,
          status,
          reviewed: null,
          landingChangedAt: new Date(),
        }),
      ).toBe("closed");
    }
  });

  it("answers `unreviewed` when the stored link is not the reviewed one, or none ever was", () => {
    expect(leavingReason("apply", { ...vouched, reviewed: null })).toBe("unreviewed");
    expect(leavingReason("apply", { ...vouched, stored: URL_B })).toBe("unreviewed");
    // Byte for byte: the pin is a copy of the same column, so any difference is an unreviewed write.
    expect(leavingReason("apply", { ...vouched, stored: `${URL_A}?ref=x` })).toBe("unreviewed");
    expect(leavingReason("source", { ...vouched, reviewed: URL_B })).toBe("unreviewed");
  });

  it("puts `unreviewed` ahead of `landing_changed`", () => {
    expect(
      leavingReason("apply", { ...vouched, reviewed: URL_B, landingChangedAt: new Date() }),
    ).toBe("unreviewed");
  });

  it("answers `landing_changed` for the apply link only — the source check never fetches `website`", () => {
    const moved = { ...vouched, landingChangedAt: new Date() };
    expect(leavingReason("apply", moved)).toBe("landing_changed");
    expect(leavingReason("source", moved)).toBeNull();
  });
});

describe("leavingPageUrl", () => {
  it("is the configured frontend origin's leaving page, with the id's colon percent-encoded", () => {
    expect(leavingPageUrl("https://rfpsear.ch", "fundingmap:1459", "apply", "unreviewed")).toBe(
      "https://rfpsear.ch/leaving/fundingmap%3A1459?link=apply&reason=unreviewed",
    );
    expect(leavingPageUrl("http://localhost:3005", "a:b/c?d", "source", "closed")).toBe(
      "http://localhost:3005/leaving/a%3Ab%2Fc%3Fd?link=source&reason=closed",
    );
  });
});

describe("reviewerPins", () => {
  it("pins both links to what is stored and clears the landing flag", () => {
    expect(reviewerPins({ applicationUrl: URL_A, website: URL_B })).toEqual({
      reviewedApplicationUrl: URL_A,
      reviewedWebsite: URL_B,
      linkLandingChangedAt: null,
    });
  });

  it("pins an absent link as NULL, which never vouches for a link added later", () => {
    const pins = reviewerPins({ applicationUrl: URL_A });
    expect(pins.reviewedWebsite).toBeNull();
    expect(
      leavingReason("source", { ...vouched, stored: URL_B, reviewed: pins.reviewedWebsite }),
    ).toBe("unreviewed");
  });
});

describe("landingMove", () => {
  const landed = (
    finalUrl: string | null,
    requestedUrl: string | null = "https://go.example.org/apply",
  ) => ({
    requestedUrl,
    finalUrl,
  });

  it("reports a landing on another site, for the same requested URL", () => {
    expect(
      landingMove(
        landed("https://forms.first.example/x"),
        landed("https://forms.second.example/x"),
      ),
    ).toEqual({ from: "first.example", to: "second.example" });
  });

  it("is quiet for the same site, including across subdomains and paths", () => {
    expect(
      landingMove(landed("https://forms.first.example/x"), landed("https://www.first.example/y")),
    ).toBeUndefined();
  });

  it("is quiet without a baseline yet, or when the requested URL itself changed", () => {
    expect(
      landingMove(landed(null, null), landed("https://forms.second.example/x")),
    ).toBeUndefined();
    expect(
      landingMove(
        landed("https://forms.first.example/x", "https://go.example.org/old"),
        landed("https://forms.second.example/x"),
      ),
    ).toBeUndefined();
  });

  it("is quiet when either side has no final URL it can read a site from", () => {
    expect(landingMove(landed(null), landed("https://forms.first.example/x"))).toBeUndefined();
    expect(landingMove(landed("https://forms.first.example/x"), landed(null))).toBeUndefined();
    expect(landingMove(landed("go.example.org"), landed("https://x.example/"))).toBeUndefined();
  });

  it("compares wherever the answered check ended, a redirect target included", () => {
    expect(
      landingMove(landed("https://forms.first.example/x"), landed("https://loop.other.example/")),
    ).toEqual({ from: "first.example", to: "other.example" });
  });
});
