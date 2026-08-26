import type { VerificationRun } from "@/lib/types";
import { verificationPresentation } from "@/lib/verification";
import { describe, expect, it } from "vitest";

const run = (over: Partial<VerificationRun> = {}): VerificationRun => ({
  runAt: "2026-08-25T12:00:00Z",
  requestedUrl: "https://example.org/apply",
  finalUrl: "https://example.org/apply",
  httpStatus: 200,
  existsAtSource: true,
  matched: true,
  fieldDiff: null,
  extracted: null,
  snapshotSha256: null,
  error: null,
  ...over,
});

describe("verification response presentation", () => {
  it.each([
    [403, null],
    [404, null],
    [200, { automatedCheckBlocked: true }],
  ])("treats HTTP %s or a challenge-shaped page as blocked, not missing", (status, extracted) => {
    expect(
      verificationPresentation(
        run({ httpStatus: status, existsAtSource: false, matched: false, extracted }),
      ),
    ).toEqual({
      response: `Site refused or blocked the automated check (HTTP ${status}).`,
      pageExists: null,
      uncertain: true,
    });
  });

  it("distinguishes a genuine network failure with no HTTP response", () => {
    expect(
      verificationPresentation(
        run({
          httpStatus: null,
          finalUrl: null,
          existsAtSource: false,
          matched: false,
          error: "transport_failure: connection reset",
        }),
      ),
    ).toEqual({
      response: "Network check failed before an HTTP response.",
      pageExists: null,
      uncertain: true,
    });
  });

  it("keeps the HTTP status primary for another failed check", () => {
    expect(
      verificationPresentation(
        run({
          httpStatus: 502,
          existsAtSource: false,
          matched: false,
          error: "content_type_not_allowed: application/octet-stream",
        }),
      ).response,
    ).toBe("Automated check failed (HTTP 502).");
  });

  it("reports the reachable and soft-not-found branches with their HTTP statuses", () => {
    expect(verificationPresentation(run()).response).toBe("Page found (HTTP 200).");
    expect(verificationPresentation(run({ existsAtSource: false, matched: false })).response).toBe(
      "Page appears unavailable (HTTP 200).",
    );
  });
});
