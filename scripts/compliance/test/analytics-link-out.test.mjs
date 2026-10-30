/**
 * The analytics criterion's link-out: the `Location` it accepts.
 *
 * Since the API vouches only for links a hub reviewer pinned, the criterion's own fixture — a
 * verified publisher's auto-approved create — is redirected to the frontend's leaving page rather
 * than to its stored `applicationUrl`. Both are correct answers; anything else is not.
 */
import { describe, expect, it } from "vitest";
import { LEAVING_REASONS, linkOutLanding } from "../checks/analytics.mjs";

const ID = "my-org:m3-compliance-published-abc";
const STORED = "https://api.example.org/v1/docs";
const fixture = { id: ID, kind: "apply", destination: STORED };

describe("linkOutLanding", () => {
  it("accepts the entry's stored link — a vouched link-out", () => {
    expect(linkOutLanding(STORED, fixture)).toEqual({
      ok: true,
      detail: "the entry's stored applicationUrl",
    });
  });

  it("accepts the hub's leaving page for this entry and this link, with every contract reason", () => {
    for (const reason of LEAVING_REASONS) {
      const location = `https://rfpsear.ch/leaving/${encodeURIComponent(ID)}?link=apply&reason=${reason}`;
      const verdict = linkOutLanding(location, fixture);
      expect(verdict.ok, reason).toBe(true);
      expect(verdict.detail).toContain(reason);
    }
  });

  it("refuses a leaving page for another entry, another link, or a reason the frontend cannot say", () => {
    const other = `https://rfpsear.ch/leaving/${encodeURIComponent("my-org:other")}?link=apply&reason=closed`;
    const source = `https://rfpsear.ch/leaving/${encodeURIComponent(ID)}?link=source&reason=closed`;
    const unknown = `https://rfpsear.ch/leaving/${encodeURIComponent(ID)}?link=apply&reason=spooky`;
    // The id's colon must be percent-encoded, which is what the API emits.
    const raw = `https://rfpsear.ch/leaving/${ID}?link=apply&reason=closed`;
    for (const location of [other, source, unknown, raw]) {
      expect(linkOutLanding(location, fixture).ok, location).toBe(false);
    }
  });

  it("refuses any other destination, and a missing or relative Location", () => {
    expect(linkOutLanding("https://evil.example/phish", fixture).ok).toBe(false);
    expect(linkOutLanding(undefined, fixture)).toEqual({ ok: false, detail: "no Location header" });
    expect(linkOutLanding("/leaving/x", fixture).ok).toBe(false);
  });
});
