/**
 * The three rules the client exists to enforce: anonymous reads, no retry on a write, and a hard
 * response cap.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, MAX_RESPONSE_BYTES, retryAfterMs } from "../src/http.js";
import { FAKE_KEY, listPage, rejection, stubFetch, testConfig, validDocument } from "./helpers.js";

describe("retry-after parsing", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  it("reads delta-seconds and caps the wait", () => {
    expect(retryAfterMs("2", now)).toBe(2_000);
    expect(retryAfterMs("600", now)).toBe(5_000);
  });

  it("reads an HTTP-date and caps the wait", () => {
    expect(retryAfterMs("Mon, 01 Jun 2026 12:00:03 GMT", now)).toBe(3_000);
    expect(retryAfterMs("Mon, 01 Jun 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("falls back to a second on anything it cannot parse", () => {
    expect(retryAfterMs(null, now)).toBe(1_000);
    expect(retryAfterMs("soon", now)).toBe(1_000);
    expect(retryAfterMs("", now)).toBe(1_000);
  });

  it("clamps every hostile value into 0…5 seconds", () => {
    for (const header of ["-30", "-1e12", "1e400", "999999999", "  7  ", "0x10"]) {
      const wait = retryAfterMs(header, now);
      expect(wait, header).toBeGreaterThanOrEqual(0);
      expect(wait, header).toBeLessThanOrEqual(5_000);
    }
    expect(retryAfterMs("-30", now)).toBe(0);
    expect(retryAfterMs("Mon, 01 Jun 2020 00:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("Mon, 01 Jun 2099 00:00:00 GMT", now)).toBe(5_000);
  });
});

describe("reads", () => {
  it("retries a 429 exactly once, then fails", async () => {
    const stub = stubFetch([
      { status: 429, headers: { "retry-after": "1" }, body: { error: "rate_limited" } },
      { status: 429, headers: { "retry-after": "1" }, body: { error: "rate_limited" } },
    ]);
    const client = new ApiClient(testConfig(), {
      fetchImpl: stub.fetchImpl,
      sleep: async () => {},
    });
    await expect(client.listOpportunities(new URLSearchParams())).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(stub.calls).toHaveLength(2);
  });

  it("succeeds on the retry when the second answer is good", async () => {
    const stub = stubFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { body: listPage([]) },
    ]);
    const client = new ApiClient(testConfig(), {
      fetchImpl: stub.fetchImpl,
      sleep: async () => {},
    });
    const page = await client.listOpportunities(new URLSearchParams());
    expect(page.total).toBe(0);
    expect(stub.calls).toHaveLength(2);
  });

  it("reports an unreachable API as exec_failed with the origin, not the key", async () => {
    const client = new ApiClient(testConfig(), {
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    const error = await rejection(client.getOpportunity("x:y"));
    expect(error.message).toContain("https://api.example.test");
    expect(error.message).not.toContain(FAKE_KEY);
  });
});

describe("writes", () => {
  it("never retries, at any status", async () => {
    const stub = stubFetch([{ status: 500, body: { error: "internal" } }]);
    const client = new ApiClient(testConfig(), {
      fetchImpl: stub.fetchImpl,
      sleep: async () => {},
    });
    await expect(client.submitOpportunity(validDocument())).rejects.toThrow();
    expect(stub.calls).toHaveLength(1);
  });

  it("reports an ambiguous transport failure as ambiguous, and says where to check", async () => {
    const client = new ApiClient(testConfig(), {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    const error = await rejection(client.submitOpportunity(validDocument()));
    expect(error.message).toContain("UNKNOWN");
    expect(error.message).toContain("/v1/me/opportunities");
  });

  it("refuses without a credential rather than sending an unauthenticated write", async () => {
    const stub = stubFetch([{ body: {} }]);
    const client = new ApiClient(testConfig({ apiKey: null }), { fetchImpl: stub.fetchImpl });
    await expect(client.submitOpportunity(validDocument())).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("the 1 MB cap fails loud", () => {
  it("refuses an over-cap body instead of truncating it", async () => {
    const oversized = JSON.stringify({ pad: "x".repeat(MAX_RESPONSE_BYTES) });
    const stub = stubFetch([{ raw: oversized }]);
    const client = new ApiClient(testConfig(), { fetchImpl: stub.fetchImpl });
    const error = await rejection(client.listOpportunities(new URLSearchParams()));
    expect(error.message).toContain("Narrow the request");
    expect(error.message).toContain("Nothing was truncated");
  });

  it("refuses on a declared content-length before reading the body", async () => {
    const stub = stubFetch([
      { body: { ok: true }, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } },
    ]);
    const client = new ApiClient(testConfig(), { fetchImpl: stub.fetchImpl });
    await expect(client.listOpportunities(new URLSearchParams())).rejects.toMatchObject({
      code: "exec_failed",
    });
  });
});

describe("non-JSON bodies", () => {
  it("are reported as a transport problem, not a server error", async () => {
    const stub = stubFetch([{ status: 502, raw: "<html>Bad Gateway</html>" }]);
    const client = new ApiClient(testConfig(), { fetchImpl: stub.fetchImpl });
    const error = await rejection(client.listOpportunities(new URLSearchParams()));
    expect(error.details?.transport).toBe(true);
  });
});
