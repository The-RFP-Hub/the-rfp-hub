/**
 * A 2xx is not an answer until its body has been checked.
 *
 * The two sides fail differently and must. A READ that gets a shape this build does not recognize
 * has done nothing, so it is a plain coded failure. A WRITE that gets one has already sent the
 * document, so the outcome is unknown and the caller has to be sent to the owner listing rather
 * than told "failed".
 */
import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/http.js";
import {
  listPage,
  rejection,
  stubFetch,
  summaryItem,
  testConfig,
  validDocument,
} from "./helpers.js";

function client(responses: Parameters<typeof stubFetch>[0]) {
  return new ApiClient(testConfig(), { fetchImpl: stubFetch(responses).fetchImpl });
}

function submissionBody(overrides: Record<string, unknown> = {}) {
  return {
    opportunity: validDocument(),
    created: true,
    reviewStatus: "pending",
    isListed: false,
    warnings: [],
    duplicateCheck: "ok",
    duplicates: [],
    ...overrides,
  };
}

describe("a read's 2xx body", () => {
  it("refuses an empty object rather than reporting no results", async () => {
    const error = await rejection(client([{ body: {} }]).listOpportunities(new URLSearchParams()));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("is not a page of opportunities");
  });

  it("refuses a page with no pagination, or with pagination that is not a count", async () => {
    const bad = [
      { items: [] },
      { items: [], page: "1", limit: 10, total: 0, totalPages: 1 },
      { items: [], page: 0, limit: 10, total: 0, totalPages: 1 },
      { items: [], page: -1, limit: 10, total: 0, totalPages: 1 },
      { items: [], page: 1.5, limit: 10, total: 0, totalPages: 1 },
      { items: [], page: 1, limit: 10, total: -3, totalPages: 1 },
      { items: [], page: 1, limit: 10, total: 0, totalPages: 0 },
      { items: {}, page: 1, limit: 10, total: 0, totalPages: 1 },
    ];
    for (const body of bad) {
      const error = await rejection(client([{ body }]).listOpportunities(new URLSearchParams()));
      expect(error.message, JSON.stringify(body)).toContain("is not a page of opportunities");
    }
  });

  it("refuses a page whose items are not opportunities", async () => {
    const error = await rejection(
      client([{ body: listPage([{ id: "example-org:x" }]) }]).listOpportunities(
        new URLSearchParams(),
      ),
    );
    expect(error.message).toContain("is not a page of opportunities");
  });

  it("refuses an empty object where one document was asked for", async () => {
    const error = await rejection(client([{ body: {} }]).getOpportunity("example-org:x"));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("is not one opportunity document");
  });

  it("accepts members it has never heard of, on the page and on an item", async () => {
    const page = {
      ...listPage([summaryItem({ inventedLater: true })]),
      alsoInventedLater: { nested: 1 },
    };
    await expect(
      client([{ body: page }]).listOpportunities(new URLSearchParams()),
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      client([{ body: { ...validDocument(), inventedLater: true } }]).getOpportunity(
        "example-org:x",
      ),
    ).resolves.toMatchObject({ id: "example-org:test-grant" });
  });
});

describe("a write's 2xx body", () => {
  const ambiguous = "may have landed";

  it("treats an unknown duplicateCheck as ambiguous, not as a crash after the write", async () => {
    const error = await rejection(
      client([{ body: submissionBody({ duplicateCheck: "future-value" }) }]).submitOpportunity(
        validDocument(),
      ),
    );
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain(ambiguous);
    expect(error.message).toContain("/v1/me/opportunities");
  });

  it("treats an unknown reviewStatus and missing arrays the same way", async () => {
    for (const body of [
      submissionBody({ reviewStatus: "quarantined" }),
      submissionBody({ warnings: undefined }),
      submissionBody({ duplicates: undefined }),
      submissionBody({ duplicates: [{ id: "example-org:y", similarity: 0.9 }] }),
    ]) {
      const error = await rejection(client([{ body }]).submitOpportunity(validDocument()));
      expect(error.message, JSON.stringify(body)).toContain(ambiguous);
    }
  });

  it("treats a 204 and an empty 200 as ambiguous", async () => {
    for (const spec of [{ status: 204 }, { status: 200, raw: "" }]) {
      const error = await rejection(client([spec]).submitOpportunity(validDocument()));
      expect(error.message, JSON.stringify(spec)).toContain(ambiguous);
    }
  });

  it("accepts a result carrying members it does not know", async () => {
    await expect(
      client([{ body: submissionBody({ inventedLater: 42 }) }]).submitOpportunity(validDocument()),
    ).resolves.toMatchObject({ created: true });
  });

  it("never follows a redirect, and bounds and redacts the Location it reports", async () => {
    const long = `https://elsewhere.test/${"x".repeat(500)}`;
    const stub = stubFetch([{ status: 307, headers: { location: long } }]);
    const api = new ApiClient(testConfig(), { fetchImpl: stub.fetchImpl });
    const error = await rejection(api.submitOpportunity(validDocument()));

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init?.redirect).toBe("manual");
    expect(error.message).toContain(ambiguous);
    expect(error.message).not.toContain(long);
    expect(error.message).toContain("https://elsewhere.test/xxx");
    expect(error.message.length).toBeLessThan(1_200);
  });

  it("redacts a key-shaped Location instead of quoting it", async () => {
    const stub = stubFetch([
      { status: 303, headers: { location: "https://elsewhere.test/rfph_TESTONLYleakedviaheader" } },
    ]);
    const error = await rejection(
      new ApiClient(testConfig(), { fetchImpl: stub.fetchImpl }).submitOpportunity(validDocument()),
    );
    expect(error.message).not.toContain("rfph_TESTONLYleakedviaheader");
    expect(error.message).toContain("[REDACTED-RFPHUB-KEY]");
  });
});
