/**
 * The read-only parser: what it accepts, what it refuses, and the one property that makes its
 * production defaults safe — there is no way to hand it a credential.
 */
import { describe, expect, it } from "vitest";
import { READ_CRITERIA, criterionKeys } from "../criteria.mjs";
import { describeScope, normalizeMcpSpec, parseArgs, refusals, weakenings } from "../options.mjs";

const parse = (...argv) => parseArgs(argv);

describe("targets", () => {
  it("defaults to production, because reading production is the point", () => {
    const opts = parse();
    expect(opts.api).toBe("https://api.ethrfps.app");
    expect(opts.site).toBe("https://ethrfps.app");
  });

  it("--base-url is an accepted alias for --api: it is the name the nightly job spells", () => {
    expect(parse("--base-url", "https://api.example.org").api).toBe("https://api.example.org");
    expect(parse("--api", "https://api.example.org").api).toBe("https://api.example.org");
  });

  it("carries no credential flag and no credential fallback", () => {
    for (const flag of ["--session-token", "--api-key", "--admin-token", "--allow-production"]) {
      expect(() => parse(flag, "x")).toThrow(/unknown argument/);
    }
    const opts = parse();
    for (const key of ["sessionToken", "apiKey", "adminToken", "credential", "allowProduction"]) {
      expect(opts).not.toHaveProperty(key);
    }
  });

  it("writes its report somewhere unique rather than into the checkout", () => {
    const a = parse().json;
    expect(a).toMatch(/compliance-report-\d+-.*\.json$/);
    expect(parse("--json", "-").json).toBe("-");
  });
});

describe("--milestone", () => {
  it("m2 selects the M2 criteria", () => {
    expect(refusals(parse("--milestone", "m2", "--export-url", "https://x.example"))).toEqual([]);
  });

  it("m3 is refused here, and names the tool that owns it", () => {
    const [reason] = refusals(parse("--milestone", "m3"));
    expect(reason).toContain("accept:writes --milestone m3");
  });

  it("m4 selects the M4 read criteria", () => {
    expect(refusals(parse("--milestone", "m4"))).toEqual([]);
  });

  it("a milestone whose criteria are not registered is an error, not an empty run", () => {
    const [reason] = refusals(parse("--milestone", "m9"));
    expect(reason).toContain('unknown milestone "m9"');
  });

  it("cannot be combined with --only", () => {
    const [reason] = refusals(parse("--milestone", "m2", "--only", "liveness"));
    expect(reason).toContain("cannot be combined with --only");
  });
});

describe("--only, --skip and --export-url", () => {
  it("an unknown criterion key is refused at parse time, with the keys that exist", () => {
    expect(() => parse("--only", "M2-1")).toThrow(/--only must be one of liveness, openapi/);
    expect(() => parse("--skip", "M4-4")).toThrow(/--skip must be one of/);
  });

  it("accepts every registered key, repeatable", () => {
    for (const key of criterionKeys(READ_CRITERIA)) {
      expect(() => parse("--only", key), key).not.toThrow();
    }
    expect([...parse("--skip", "mcp", "--skip", "docs").skip].sort()).toEqual(["docs", "mcp"]);
  });

  it("--export-url is required only when the export criterion actually runs", () => {
    expect(refusals(parse())).toHaveLength(1);
    expect(refusals(parse())[0]).toContain("--export-url is required");
    expect(refusals(parse("--only", "liveness"))).toEqual([]);
    expect(refusals(parse("--skip", "export"))).toEqual([]);
  });

  it("--offline needs no --export-url, because the export criterion will not run", () => {
    expect(refusals(parse("--offline"))).toEqual([]);
    expect(refusals(parse("--offline", "--milestone", "m2"))).toEqual([]);
    expect(refusals(parse("--offline", "--only", "export"))).toEqual([]);
  });

  it("--only and --skip together is refused: the combination has no one meaning", () => {
    expect(() => parse("--only", "liveness", "--skip", "export")).toThrow(/cannot be combined/);
  });
});

describe("behavior flags", () => {
  it("--browser, --offline and --expect-indexable are off by default", () => {
    const opts = parse();
    expect(opts.browser).toBe(false);
    expect(opts.offline).toBe(false);
    expect(opts.expectIndexable).toBe(false);
  });

  it("sets each of them", () => {
    const opts = parse("--browser", "--offline", "--expect-indexable");
    expect(opts.browser).toBe(true);
    expect(opts.offline).toBe(true);
    expect(opts.expectIndexable).toBe(true);
  });

  it("parses --timeout and --concurrency, and refuses a non-number", () => {
    const opts = parse("--timeout", "5000", "--concurrency", "2");
    expect(opts.timeoutMs).toBe(5000);
    expect(opts.concurrency).toBe(2);
    expect(() => parse("--timeout", "-1")).toThrow(/must be a non-negative number/);
    expect(() => parse("--timeout", "soon")).toThrow(/must be a non-negative number/);
  });

  it("names an unknown argument rather than ignoring it", () => {
    expect(() => parse("--not-a-real-flag")).toThrow(/unknown argument "--not-a-real-flag"/);
  });
});

describe("describeScope", () => {
  it("names a narrowed run as narrowed, never as a sign-off", () => {
    const label = describeScope({ only: new Set(["docs"]), skip: new Set(), offline: true });
    expect(label).toContain("docs lint, offline");
    expect(label).toContain("NOT a deployment sign-off");
  });

  it("is undefined for a full run", () => {
    expect(describeScope({ only: new Set(), skip: new Set(), offline: false })).toBeUndefined();
  });
});

/**
 * A weakening leaves every criterion registered, so `--only`'s narrowing label never fired for it:
 * a run that validated 5 of 4000 served documents printed the same green headline as one that
 * validated all of them.
 */
describe("weakening flags", () => {
  it("--max-details below all of them is a weakening, and 0 is not", () => {
    expect(weakenings(parse("--max-details", "5"))[0]).toContain("--max-details 5");
    expect(weakenings(parse("--max-details", "5"))[0]).toContain("rather than every one");
    expect(weakenings(parse("--max-details", "0"))).toEqual([]);
    expect(weakenings(parse())).toEqual([]);
  });

  it("--allow-insecure is a weakening on a remote plaintext target", () => {
    const remote = parse("--allow-insecure", "--api", "http://api.example.org");
    expect(weakenings(remote)[0]).toContain("--allow-insecure");
  });

  it("is not a weakening against an https target, where it changes nothing", () => {
    expect(weakenings(parse("--allow-insecure", "--api", "https://api.example.org"))).toEqual([]);
    expect(weakenings(parse("--allow-insecure"))).toEqual([]); // the default target is https
    expect(
      describeScope(parse("--allow-insecure", "--api", "https://api.example.org")),
    ).toBeUndefined();
  });

  it("is not a weakening on loopback, where the traffic never leaves the machine", () => {
    expect(weakenings(parse("--allow-insecure", "--api", "http://127.0.0.1:3001"))).toEqual([]);
    expect(weakenings(parse("--allow-insecure", "--api", "http://localhost:3001"))).toEqual([]);
  });

  it("carries a `weakened:` scope label, which is what makes signOff false", () => {
    const label = describeScope(parse("--max-details", "5"));
    expect(label).toContain("weakened: --max-details 5");
    expect(label).toContain("NOT a deployment sign-off");
  });

  it("says both when a run is narrowed AND weakened", () => {
    const label = describeScope(parse("--only", "dataset", "--max-details", "5"));
    expect(label).toContain("--only dataset");
    expect(label).toContain("weakened:");
  });

  it("an unweakened, unnarrowed run still has no scope label at all", () => {
    expect(describeScope(parse("--api", "https://api.example.org"))).toBeUndefined();
  });
});

describe("normalizeMcpSpec", () => {
  it("accepts a dist-tag, an exact version and local", () => {
    expect(normalizeMcpSpec("next")).toBe("next");
    expect(normalizeMcpSpec("0.1.0")).toBe("0.1.0");
    expect(normalizeMcpSpec("local")).toBe("local");
  });

  it("strips the package name the runbook spells, rather than concatenating it twice", () => {
    expect(normalizeMcpSpec("@the-rfp-hub/mcp@next")).toBe("next");
  });

  it("refuses a range, a wildcard and an empty value, with an actionable message", () => {
    for (const bad of ["*", "1.x", "^1.0.0", ">=1", "", "  "]) {
      expect(() => normalizeMcpSpec(bad)).toThrow(/--mcp-spec/);
    }
  });

  it("refuses a missing value rather than swallowing the next flag", () => {
    expect(() => parse("--mcp-spec")).toThrow(/--mcp-spec needs a value/);
  });
});
