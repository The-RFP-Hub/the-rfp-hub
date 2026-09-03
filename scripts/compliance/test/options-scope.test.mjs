/**
 * The read-only parser: what it accepts, what it refuses, and the one property that makes its
 * production defaults safe — there is no way to hand it a credential.
 */
import { describe, expect, it } from "vitest";
import { describeScope, normalizeMcpSpec, parseArgs, refusals } from "../options.mjs";

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

  it("a milestone whose criteria are not registered is an error, not an empty run", () => {
    const [reason] = refusals(parse("--milestone", "m4"));
    expect(reason).toContain('unknown milestone "m4"');
  });

  it("cannot be combined with --only", () => {
    const [reason] = refusals(parse("--milestone", "m2", "--only", "liveness"));
    expect(reason).toContain("cannot be combined with --only");
  });
});

describe("--only, --skip and --export-url", () => {
  it("an unknown criterion key is refused at parse time, with the keys that exist", () => {
    expect(() => parse("--only", "M2-1")).toThrow(/--only must be one of liveness, openapi/);
  });

  it("--export-url is required only when the export criterion actually runs", () => {
    expect(refusals(parse())).toHaveLength(1);
    expect(refusals(parse())[0]).toContain("--export-url is required");
    expect(refusals(parse("--only", "liveness"))).toEqual([]);
    expect(refusals(parse("--skip", "export"))).toEqual([]);
  });

  it("--only and --skip together is refused: the combination has no one meaning", () => {
    expect(() => parse("--only", "liveness", "--skip", "export")).toThrow(/cannot be combined/);
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

describe("normalizeMcpSpec", () => {
  it("accepts a dist-tag, an exact version and local", () => {
    expect(normalizeMcpSpec("next")).toBe("next");
    expect(normalizeMcpSpec("0.1.0")).toBe("0.1.0");
    expect(normalizeMcpSpec("local")).toBe("local");
  });

  it("strips the package name the runbook spells, rather than concatenating it twice", () => {
    expect(normalizeMcpSpec("@the-rfp-hub/mcp@next")).toBe("next");
  });

  it("refuses a range: this criterion is about one immutable artifact", () => {
    expect(() => normalizeMcpSpec("^0.1.0")).toThrow(/--mcp-spec must be/);
  });
});
