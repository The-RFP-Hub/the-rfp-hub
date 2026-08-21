/**
 * THE ANALYTICS HASHES.
 *
 * The dashboard needs "how many distinct visitors" without storing anything that says who they
 * were. What has to hold:
 *
 *   - the same visitor on the same day is one token, a different visitor is another;
 *   - the token rotates daily, so two days of traffic cannot be joined into a profile;
 *   - the stored value does not contain the address, and — the property a plain
 *     `sha256(salt + ip)` fails — recovering the address requires the key, not merely the four
 *     billion candidates the IPv4 space offers;
 *   - traffic this project generates about itself is not counted as a publisher's.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ipHash,
  isCountableRequest,
  referrerHost,
  sessionHash,
  utcDay,
} from "../../src/modules/shared/analytics-hash.js";

const KEY = "a-test-key";
const UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0";
const DAY = new Date("2026-08-14T12:00:00Z");
const NEXT = new Date("2026-08-15T00:00:01Z");

describe("sessionHash", () => {
  it("is stable for the same address, agent and day", () => {
    expect(sessionHash(KEY, "1.2.3.4", UA, DAY)).toBe(sessionHash(KEY, "1.2.3.4", UA, DAY));
    expect(sessionHash(KEY, "1.2.3.4", UA, DAY)).toMatch(/^[0-9a-f]{32}$/);
  });

  // Two browsers behind one address count as two — closer to the truth on a shared connection, and
  // less identifying than the address alone.
  it("separates different agents on one address", () => {
    expect(sessionHash(KEY, "1.2.3.4", UA, DAY)).not.toBe(
      sessionHash(KEY, "1.2.3.4", "curlish/1.0", DAY),
    );
  });

  it("separates different addresses", () => {
    expect(sessionHash(KEY, "1.2.3.4", UA, DAY)).not.toBe(sessionHash(KEY, "1.2.3.5", UA, DAY));
  });

  // The rotation is what bounds any behavioural profile to a single day.
  it("rotates at the UTC day boundary", () => {
    expect(sessionHash(KEY, "1.2.3.4", UA, DAY)).not.toBe(sessionHash(KEY, "1.2.3.4", UA, NEXT));
    expect(utcDay(DAY)).toBe("2026-08-14");
    expect(utcDay(NEXT)).toBe("2026-08-15");
  });

  it("changes entirely when the key changes", () => {
    expect(sessionHash("key-one", "1.2.3.4", UA, DAY)).not.toBe(
      sessionHash("key-two", "1.2.3.4", UA, DAY),
    );
  });
});

describe("ipHash", () => {
  it("does not depend on the user agent", () => {
    expect(ipHash(KEY, "1.2.3.4", DAY)).toBe(ipHash(KEY, "1.2.3.4", DAY));
  });

  // Different domain separators mean someone holding both stored values cannot correlate them.
  it("is not derivable from the session hash for the same visitor", () => {
    expect(ipHash(KEY, "1.2.3.4", DAY)).not.toBe(sessionHash(KEY, "1.2.3.4", UA, DAY));
  });
});

describe("what the stored value does not reveal", () => {
  it("does not contain the address", () => {
    const hash = ipHash(KEY, "203.0.114.9", DAY);
    expect(hash).not.toContain("203");
    expect(hash).not.toContain("114");
  });

  // THE REASON FOR HMAC. An unkeyed digest over the same inputs is computable by anyone; the
  // whole IPv4 space is four billion candidates, which is minutes of work. The keyed one is not
  // the same value, and cannot be produced without the key.
  it("is not the unkeyed digest an attacker could enumerate", () => {
    const naive = createHash("sha256")
      .update(`${KEY}1.2.3.4${utcDay(DAY)}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    expect(ipHash(KEY, "1.2.3.4", DAY)).not.toBe(naive);
  });
});

describe("referrerHost", () => {
  it("keeps the host and discards the path and query", () => {
    expect(referrerHost("https://Example.ORG/some/page?q=secret#frag")).toBe("example.org");
  });

  it("is undefined for absent or unusable values", () => {
    for (const value of [undefined, null, "", "   ", "not a url", "/relative/path"]) {
      expect(referrerHost(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe("isCountableRequest", () => {
  it("counts an ordinary browser", () => {
    expect(isCountableRequest(UA, undefined)).toBe(true);
  });

  // Without this the nightly export and the compliance run — every night, against production —
  // would be most of every publisher's view count.
  it("never counts this project's own automation", () => {
    for (const ua of ["rfphub-exporter/0.0.2", "rfphub-m2-compliance", "rfphub-m3-compliance"]) {
      expect(isCountableRequest(ua, undefined), ua).toBe(false);
    }
  });

  it("does not count obvious crawlers or agentless requests", () => {
    for (const ua of [
      "Googlebot/2.1",
      "curl/8.4.0",
      "python-requests/2.31",
      "HeadlessChrome/120",
      undefined,
      "",
    ]) {
      expect(isCountableRequest(ua, undefined), String(ua)).toBe(false);
    }
  });

  // Not legally required and trivially ignorable — which is exactly why honouring it means
  // something. The cost is a slightly smaller number on a chart already labelled best-effort.
  it("honours DNT: 1", () => {
    expect(isCountableRequest(UA, "1")).toBe(false);
    expect(isCountableRequest(UA, "0")).toBe(true);
  });
});
