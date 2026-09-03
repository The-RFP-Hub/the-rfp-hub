/**
 * The refusals of the tool that writes — because a guard that is wrong is worse than no guard, and
 * every one of these is a rule with edge cases rather than a one-line condition.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, refusals } from "../accept-options.mjs";
import { WRITE_MILESTONES } from "../criteria.mjs";

const complete = {
  milestone: "m3",
  api: "https://api-staging.ethrfps.app",
  namespace: "my-org",
  sessionToken: "t",
  adminToken: "a",
};

const check = (opts, env = {}) => refusals(opts, WRITE_MILESTONES, env);

describe("refusals", () => {
  it("passes a complete invocation against an allowlisted staging origin", () => {
    expect(check(complete)).toEqual([]);
  });

  it("requires a milestone, an API, a namespace, a publisher credential and a reviewer", () => {
    expect(check({}).length).toBe(5);
    expect(check({ ...complete, milestone: undefined })[0]).toMatch(/--milestone is required/);
    expect(check({ ...complete, api: undefined })[0]).toMatch(/--api is required/);
    expect(check({ ...complete, namespace: undefined })[0]).toMatch(/--namespace/);
    expect(check({ ...complete, sessionToken: undefined, adminToken: undefined })[0]).toMatch(
      /--session-token or --api-key/,
    );
  });

  /**
   * The reviewer credential is the one that used to be optional. Without it the teardown could not
   * reject the fixtures, and the run reported that as a warning — green, with rows left behind on
   * somebody's deployment.
   */
  it("refuses a run it could not tear down", () => {
    const noReviewer = {
      ...complete,
      adminToken: undefined,
      sessionToken: undefined,
      apiKey: "rfph_x",
    };
    expect(check(noReviewer).join("\n")).toMatch(/a reviewer credential is required/);
  });

  it("accepts an API key in place of a session, as long as a reviewer session is supplied", () => {
    expect(check({ ...complete, sessionToken: undefined, apiKey: "rfph_x" })).toEqual([]);
  });

  it("holds the namespace to the slug shape ids are held to", () => {
    for (const namespace of ["My-Org", "my org", "my_org", "-my-org", "my--org"]) {
      expect(check({ ...complete, namespace })[0], namespace).toMatch(/slug/);
    }
  });

  it("refuses production, and offers no flag that unlocks it", () => {
    const reasons = check({ ...complete, api: "https://api.ethrfps.app" });
    expect(reasons[0]).toContain("is PRODUCTION");
    expect(reasons[0]).toContain("There is no flag to force production");
    expect(reasons[0]).not.toContain("--allow-production");
  });

  it("refuses a remote plaintext target: the credential would cross the wire in the clear", () => {
    expect(check({ ...complete, api: "http://api-staging.example.org" })[0]).toContain("not https");
  });

  it("refuses a staging-looking host that is not on the allowlist", () => {
    expect(check({ ...complete, api: "https://api.staging.example.org" })[0]).toContain(
      "is not an allowed write target",
    );
  });

  it("lets loopback through, plaintext included", () => {
    for (const api of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
      expect(check({ ...complete, api }), api).toEqual([]);
    }
  });

  it("m2 is refused here, and names the tool that owns it", () => {
    expect(check({ ...complete, milestone: "m2" })[0]).toContain("check:deployment --milestone m2");
  });

  it("a milestone whose criteria are not registered is an error, not an empty run", () => {
    expect(check({ ...complete, milestone: "m4" })[0]).toContain('unknown milestone "m4"');
  });
});

describe("parseArgs", () => {
  it("reads the flags a run needs", () => {
    const opts = parseArgs([
      "--milestone",
      "m3",
      "--api",
      "http://localhost:3001",
      "--namespace",
      "my-org",
      "--session-token",
      "abc",
      "--admin-token",
      "def",
      "--views",
      "9",
      "--keep-fixtures",
    ]);
    expect(opts).toMatchObject({
      milestone: "m3",
      api: "http://localhost:3001",
      namespace: "my-org",
      sessionToken: "abc",
      adminToken: "def",
      views: 9,
      keepFixtures: true,
    });
  });

  it("--base-url is still accepted as the name for --api", () => {
    expect(parseArgs(["--base-url", "http://127.0.0.1:3001"]).api).toBe("http://127.0.0.1:3001");
  });

  it("falls back to the credential environment variables, but never over a flag", () => {
    const env = {
      COMPLIANCE_SESSION_TOKEN: "from-env",
      COMPLIANCE_ADMIN_TOKEN: "admin-from-env",
      COMPLIANCE_API_KEY: "rfph_from_env",
    };
    expect(parseArgs(["--api", "http://127.0.0.1:3001"], env)).toMatchObject({
      sessionToken: "from-env",
      adminToken: "admin-from-env",
      apiKey: "rfph_from_env",
    });

    const flagWins = parseArgs(["--session-token", "from-flag"], env);
    expect(flagWins.sessionToken).toBe("from-flag");
    // The other two still fall back — one explicit flag does not disable the mechanism.
    expect(flagWins.adminToken).toBe("admin-from-env");
  });

  it("offers no production override at all", () => {
    expect(() => parseArgs(["--allow-production"])).toThrow(/unknown argument/);
  });

  it("rejects an unknown flag and a flag with no value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--api"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--views", "-3"])).toThrow(/non-negative/);
  });
});
