/**
 * Argument parsing for check-m4 — in particular `--only` vs `--skip`, which mean different things
 * (see options.mjs's docstring) and are refused together.
 */
import { describe, expect, it } from "vitest";
import { CHECK_IDS, parseArgs } from "../options.mjs";

describe("parseArgs defaults", () => {
  it("defaults to production, no checks skipped or scoped", () => {
    const opts = parseArgs([]);
    expect(opts.site).toBe("https://ethrfps.app");
    expect(opts.api).toBe("https://api.ethrfps.app");
    expect(opts.skip.size).toBe(0);
    expect(opts.only.size).toBe(0);
    expect(opts.browser).toBe(false);
    expect(opts.offline).toBe(false);
  });
});

describe("--skip", () => {
  it("accepts a known check id, repeatable", () => {
    const opts = parseArgs(["--skip", "mcp", "--skip", "docs"]);
    expect([...opts.skip].sort()).toEqual(["docs", "mcp"]);
  });

  it("rejects an unknown check id", () => {
    expect(() => parseArgs(["--skip", "nope"])).toThrow(/--skip must be one of/);
  });
});

describe("--only", () => {
  it("accepts a known check id, repeatable", () => {
    const opts = parseArgs(["--only", "docs"]);
    expect([...opts.only]).toEqual(["docs"]);
  });

  it("rejects an unknown check id", () => {
    expect(() => parseArgs(["--only", "nope"])).toThrow(/--only must be one of/);
  });

  it("accepts every declared check id", () => {
    for (const id of CHECK_IDS) {
      expect(() => parseArgs(["--only", id])).not.toThrow();
    }
  });
});

describe("--only and --skip together", () => {
  it("is refused regardless of order", () => {
    expect(() => parseArgs(["--only", "docs", "--skip", "mcp"])).toThrow(
      /--only and --skip cannot be combined/,
    );
    expect(() => parseArgs(["--skip", "mcp", "--only", "docs"])).toThrow(
      /--only and --skip cannot be combined/,
    );
  });
});

describe("numeric and boolean flags", () => {
  it("parses --timeout and --concurrency", () => {
    const opts = parseArgs(["--timeout", "5000", "--concurrency", "2"]);
    expect(opts.timeoutMs).toBe(5000);
    expect(opts.concurrency).toBe(2);
  });

  it("rejects a negative or non-numeric --timeout", () => {
    expect(() => parseArgs(["--timeout", "-1"])).toThrow(/must be a non-negative number/);
    expect(() => parseArgs(["--timeout", "soon"])).toThrow(/must be a non-negative number/);
  });

  it("sets --browser and --offline", () => {
    const opts = parseArgs(["--browser", "--offline"]);
    expect(opts.browser).toBe(true);
    expect(opts.offline).toBe(true);
  });
});

describe("unknown arguments", () => {
  it("throws naming the argument", () => {
    expect(() => parseArgs(["--not-a-real-flag"])).toThrow(/unknown argument "--not-a-real-flag"/);
  });
});

describe("--expect-indexable", () => {
  it("is off by default and set by the flag", () => {
    expect(parseArgs([]).expectIndexable).toBe(false);
    expect(parseArgs(["--expect-indexable"]).expectIndexable).toBe(true);
  });
});

describe("--mcp-spec", () => {
  it("accepts a dist-tag, an exact version and local", () => {
    expect(parseArgs(["--mcp-spec", "next"]).mcpSpec).toBe("next");
    expect(parseArgs(["--mcp-spec", "0.1.0"]).mcpSpec).toBe("0.1.0");
    expect(parseArgs(["--mcp-spec", "1.0.0-rc.1"]).mcpSpec).toBe("1.0.0-rc.1");
    expect(parseArgs(["--mcp-spec", "local"]).mcpSpec).toBe("local");
  });

  it("normalizes the full package form the operator runbook spells out", () => {
    // Concatenated, this produced `@the-rfp-hub/mcp@@the-rfp-hub/mcp@next` and an npm ENOENT
    // nobody could read back to the flag.
    expect(parseArgs(["--mcp-spec", "@the-rfp-hub/mcp@next"]).mcpSpec).toBe("next");
    expect(parseArgs(["--mcp-spec", "@the-rfp-hub/mcp@0.1.0"]).mcpSpec).toBe("0.1.0");
  });

  it("refuses a range, a wildcard and an empty value, with an actionable message", () => {
    for (const bad of ["*", "1.x", "^1.0.0", ">=1", "", "  "]) {
      expect(() => parseArgs(["--mcp-spec", bad])).toThrow(/--mcp-spec/);
    }
  });

  it("refuses a missing value rather than swallowing the next flag", () => {
    expect(() => parseArgs(["--mcp-spec"])).toThrow(/--mcp-spec needs a value/);
  });
});
