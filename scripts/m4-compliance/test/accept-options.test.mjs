/**
 * Argument parsing for `scripts/accept-m4.mjs` — in particular `--timeout`, which an earlier
 * revision passed straight through `Number()` with no validation at all, unlike every other
 * numeric flag in this repo's checkers (`--views`/`--timeout`/`--concurrency` in
 * `m3-compliance/options.mjs`, `--timeout`/`--concurrency` in `m4-compliance/options.mjs`), so
 * `--timeout abc` silently became `NaN` and `--timeout -1` was accepted outright.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, refusals } from "../accept/options.mjs";

describe("parseArgs --timeout", () => {
  it("accepts a non-negative number", () => {
    const opts = parseArgs(["--timeout", "5000"]);
    expect(opts.timeoutMs).toBe(5000);
  });

  it("accepts zero", () => {
    const opts = parseArgs(["--timeout", "0"]);
    expect(opts.timeoutMs).toBe(0);
  });

  it("rejects a non-numeric value, naming the flag", () => {
    expect(() => parseArgs(["--timeout", "soon"])).toThrow(
      /--timeout must be a non-negative number/,
    );
  });

  it("rejects a negative value", () => {
    expect(() => parseArgs(["--timeout", "-1"])).toThrow(/--timeout must be a non-negative number/);
  });

  it("rejects NaN/Infinity-shaped input", () => {
    expect(() => parseArgs(["--timeout", "NaN"])).toThrow(
      /--timeout must be a non-negative number/,
    );
    expect(() => parseArgs(["--timeout", "Infinity"])).toThrow(
      /--timeout must be a non-negative number/,
    );
  });

  it("defaults to 20000 when not passed", () => {
    const opts = parseArgs([]);
    expect(opts.timeoutMs).toBe(20000);
  });
});

describe("refusals", () => {
  const complete = {
    api: "https://api.staging.example.org",
    reviewerToken: "t",
    writeKey: "rfph_x",
  };

  it("passes with api, both credentials, and a staging-shaped host", () => {
    expect(refusals(complete)).toEqual([]);
  });

  it("requires --api", () => {
    expect(refusals({ ...complete, api: undefined })).toContain("--api is required");
  });

  it("requires both credentials, named individually", () => {
    const reasons = refusals({ ...complete, reviewerToken: undefined, writeKey: undefined });
    expect(reasons.some((r) => r.includes("RFPHUB_REVIEWER_TOKEN"))).toBe(true);
    expect(reasons.some((r) => r.includes("RFPHUB_WRITE_KEY"))).toBe(true);
  });

  it("refuses a production-shaped host without --allow-production", () => {
    const reasons = refusals({ ...complete, api: "https://api.ethrfps.app" });
    expect(reasons.some((r) => r.includes("--allow-production"))).toBe(true);
  });

  it("allows a production-shaped host with --allow-production", () => {
    const reasons = refusals({
      ...complete,
      api: "https://api.ethrfps.app",
      allowProduction: true,
    });
    expect(reasons).toEqual([]);
  });
});
