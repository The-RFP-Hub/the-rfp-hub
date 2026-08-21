/**
 * Who gets counted, and what is recorded about them.
 *
 * `analyticsContextOf` is where the exclusion rule and the hashing meet, and it is exported
 * separately from the Fastify decorator precisely so this can be tested without a server: the rule
 * is a pure function of headers and an address.
 */
import { describe, expect, it } from "vitest";
import { analyticsContextOf } from "../../src/plugins/analytics-context.js";

const KEY = "unit-test-analytics-key";
const AT = new Date("2026-08-14T12:00:00.000Z");
const READER = "Mozilla/5.0 (X11; Linux x86_64) TestReader/1.0";

function context(headers: Record<string, string>, ip = "203.0.113.7", enabled = true) {
  return analyticsContextOf({ headers, ip } as never, { key: KEY, enabled, now: AT });
}

describe("analytics context", () => {
  it("counts an ordinary reader and hashes them", () => {
    const result = context({ "user-agent": READER });
    expect(result.countable).toBe(true);
    expect(result.sessionHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.ipHash).toMatch(/^[0-9a-f]{32}$/);
    // Keyed differently, so the two stored values cannot be correlated by whoever obtains them.
    expect(result.sessionHash).not.toBe(result.ipHash);
    // And neither is the address, in any form.
    expect(result.sessionHash).not.toContain("203");
  });

  it("excludes this project's own automation by name", () => {
    // Without this the nightly export and the compliance run — both against production, both
    // walking every entry — would be most of every publisher's view count.
    for (const agent of [
      "rfphub-exporter/1.0.0",
      "rfphub-m2-compliance",
      "rfphub-m3-compliance/0.1",
    ]) {
      expect(context({ "user-agent": agent }).countable, agent).toBe(false);
    }
  });

  it("excludes crawlers, scripted clients, an absent agent and DNT", () => {
    const cases: Record<string, string>[] = [
      { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
      { "user-agent": "curl/8.4.0" },
      { "user-agent": "python-requests/2.31" },
      { "user-agent": "" },
      { "user-agent": READER, dnt: "1" },
    ];
    for (const headers of cases) {
      expect(context(headers).countable, JSON.stringify(headers)).toBe(false);
    }
    // Anything other than exactly "1" is not an opt-out — `DNT: 0` is a stated preference to be
    // counted, and treating it as an opt-out would be reading the header backwards.
    expect(context({ "user-agent": READER, dnt: "0" }).countable).toBe(true);
  });

  it("records the referring HOST and never the page", () => {
    const result = context({
      "user-agent": READER,
      referer: "https://forum.example.org/t/which-grants-are-open/1487?page=3",
    });
    expect(result.referrer).toBe("forum.example.org");
  });

  it("separates two agents on one address, and two addresses on one agent", () => {
    const a = context({ "user-agent": READER });
    const b = context({ "user-agent": "Mozilla/5.0 (Macintosh) OtherReader/2.0" });
    const c = context({ "user-agent": READER }, "198.51.100.4");

    expect(a.sessionHash).not.toBe(b.sessionHash);
    expect(a.ipHash, "the address token ignores the agent").toBe(b.ipHash);
    expect(a.sessionHash).not.toBe(c.sessionHash);
    expect(a.ipHash).not.toBe(c.ipHash);
  });

  it("rotates daily, so yesterday's token cannot be joined to today's", () => {
    const today = analyticsContextOf(
      { headers: { "user-agent": READER }, ip: "203.0.113.7" } as never,
      {
        key: KEY,
        enabled: true,
        now: AT,
      },
    );
    const tomorrow = analyticsContextOf(
      { headers: { "user-agent": READER }, ip: "203.0.113.7" } as never,
      { key: KEY, enabled: true, now: new Date("2026-08-15T12:00:00.000Z") },
    );
    expect(today.sessionHash).not.toBe(tomorrow.sessionHash);
    expect(today.ipHash).not.toBe(tomorrow.ipHash);
  });

  it("records nothing at all when analytics are off", () => {
    const result = context({ "user-agent": READER }, "203.0.113.7", false);
    expect(result).toEqual({
      countable: false,
      sessionHash: null,
      ipHash: null,
      referrer: null,
    });
  });
});
