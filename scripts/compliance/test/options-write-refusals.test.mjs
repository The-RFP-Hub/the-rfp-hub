/**
 * The refusals of the tool that writes — because a guard that is wrong is worse than no guard, and
 * every one of these is a rule with edge cases rather than a one-line condition.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, refusals } from "../accept-options.mjs";
import { WRITE_MILESTONES } from "../criteria.mjs";
import { reviewerCredential } from "../reviewer-preflight.mjs";

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

  // The reviewer credential used to be optional, and a run without one reported the fixtures it
  // could not reject as a warning — green, with rows left behind on somebody's deployment.
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
    expect(reasons[0]).toContain("There is no flag and no variable that forces production");
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
    expect(check({ ...complete, milestone: "m9" })[0]).toContain('unknown milestone "m9"');
  });
});

describe("selecting across profiles", () => {
  const m3 = {
    milestone: "m3",
    api: "https://api-staging.ethrfps.app",
    namespace: "my-org",
    sessionToken: "t",
    adminToken: "a",
  };
  const m4 = {
    milestone: "m4",
    api: "https://api-staging.ethrfps.app",
    sessionToken: "t",
    apiKey: "rfph_x",
  };

  it("refuses --only lifecycle under m4, naming the profile it belongs to", () => {
    const [reason] = check({ ...m4, only: new Set(["lifecycle"]) });
    expect(reason).toContain("--only lifecycle is not part of the M4 profile");
    expect(reason).toContain("belongs to m3");
  });

  it("refuses --only submission-cycle under m3, naming the profile it belongs to", () => {
    const [reason] = check({ ...m3, only: new Set(["submission-cycle"]) });
    expect(reason).toContain("--only submission-cycle is not part of the M3 profile");
    expect(reason).toContain("belongs to m4");
  });

  it("refuses a cross-profile --skip the same way", () => {
    expect(check({ ...m4, skip: new Set(["staleness"]) })[0]).toContain(
      "--skip staleness is not part of the M4 profile",
    );
  });

  it("leaves a key from the run's own profile alone", () => {
    expect(check({ ...m3, only: new Set(["audit"]) })).toEqual([]);
    expect(check({ ...m4, only: new Set(["submission-cycle"]) })).toEqual([]);
  });
});

describe("the m4 profile's refusals", () => {
  const submission = {
    milestone: "m4",
    api: "https://api-staging.ethrfps.app",
    sessionToken: "t",
    apiKey: "rfph_x",
  };

  it("passes with the same credential names the m3 profile uses", () => {
    expect(check(submission)).toEqual([]);
  });

  it("wants no namespace: it submits through the MCP server, in the compliance namespace", () => {
    expect(check({ ...submission, namespace: undefined })).toEqual([]);
  });

  it("takes an --admin-token in place of the session, as the m3 profile does", () => {
    expect(check({ ...submission, sessionToken: undefined, adminToken: "a" })).toEqual([]);
  });

  it("names each missing credential individually", () => {
    const reasons = check({ ...submission, sessionToken: undefined, apiKey: undefined });
    expect(reasons).toHaveLength(2);
    expect(reasons.join("\n")).toContain("--api-key is required");
    expect(reasons.join("\n")).toContain("a reviewer credential is required");
  });

  it("refuses production before a single request is made", () => {
    const reasons = check({ ...submission, api: "https://api.ethrfps.app" });
    expect(reasons[0]).toContain("is PRODUCTION");
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

  it("resolves the teardown credential the same way for both profiles", () => {
    // A separate m4-only credential used to exist, read from its own variables, so a token left in
    // the shell could outrank an --admin-token passed by hand. There is one set now.
    const m3 = parseArgs(["--milestone", "m3", "--admin-token", "admin-flag"], {});
    expect(reviewerCredential(m3)).toEqual({ token: "admin-flag", flag: "--admin-token" });

    const m4 = parseArgs(["--milestone", "m4", "--admin-token", "admin-flag"], {});
    expect(reviewerCredential(m4)).toEqual({ token: "admin-flag", flag: "--admin-token" });

    const session = parseArgs(["--milestone", "m4", "--session-token", "s"], {});
    expect(reviewerCredential(session)).toEqual({ token: "s", flag: "--session-token" });
  });

  it("reads the same three variables whatever the milestone", () => {
    const env = {
      COMPLIANCE_SESSION_TOKEN: "s",
      COMPLIANCE_ADMIN_TOKEN: "a",
      COMPLIANCE_API_KEY: "rfph_env",
    };
    for (const milestone of ["m3", "m4"]) {
      expect(parseArgs(["--milestone", milestone], env)).toMatchObject({
        sessionToken: "s",
        adminToken: "a",
        apiKey: "rfph_env",
      });
    }
  });

  it("reads the m4 profile's own flags", () => {
    const opts = parseArgs([
      "--milestone",
      "m4",
      "--api-key",
      "rfph_x",
      "--repo-root",
      "/tmp/checkout",
      "--mcp-spec",
      "@the-rfp-hub/mcp@0.1.0",
      "--approve-timeout",
      "9000",
    ]);
    expect(opts).toMatchObject({
      milestone: "m4",
      apiKey: "rfph_x",
      repoRoot: "/tmp/checkout",
      mcpSpec: "0.1.0",
      approveTimeoutMs: 9000,
      interactiveApproval: false,
    });
  });

  it("has no flag for a credential outside the one set", () => {
    for (const flag of ["--reviewer-token", "--write-key"]) {
      expect(() => parseArgs([flag, "x"])).toThrow(/unknown argument/);
    }
  });

  // Waiting on a person is not waiting on a process, and an explicit flag still wins.
  it("--interactive-approval raises the approval timeout unless one was named", () => {
    expect(parseArgs(["--interactive-approval"]).approveTimeoutMs).toBe(300000);
    expect(
      parseArgs(["--interactive-approval", "--approve-timeout", "60000"]).approveTimeoutMs,
    ).toBe(60000);
    expect(parseArgs([]).approveTimeoutMs).toBe(15000);
  });

  it("narrows the profile with --only, and refuses it together with --skip", () => {
    expect([...parseArgs(["--only", "audit"]).only]).toEqual(["audit"]);
    expect(() => parseArgs(["--only", "audit", "--skip", "staleness"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseArgs(["--only", "M3-3"])).toThrow(/--only must be one of lifecycle/);
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
