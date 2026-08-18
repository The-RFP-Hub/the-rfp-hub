/**
 * The two refusals, tested — because a guard that is wrong is worse than no guard, and both of
 * these are rules with edge cases rather than one-line conditions.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, refusals, requiresProductionOptIn } from "./options.mjs";

const complete = {
  baseUrl: "https://api.staging.example.org",
  namespace: "my-org",
  privyToken: "t",
};

describe("the production guard", () => {
  it("lets loopback through", () => {
    for (const url of [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://[::1]:3001",
      "http://api.localhost",
    ]) {
      expect(requiresProductionOptIn(url), url).toBe(false);
    }
  });

  it("lets an obviously non-production host through", () => {
    for (const url of [
      "https://api.staging.example.org",
      "https://api-staging.example.org",
      "https://staging-api.example.org",
      "https://api.dev.example.org",
      "https://sandbox.example.org",
    ]) {
      expect(requiresProductionOptIn(url), url).toBe(false);
    }
  });

  /**
   * DEFAULT-DENY is the whole design. A blocklist of production hostnames has to be right about a
   * name nobody remembered to add, and the failure mode is fixture rows in the live dataset.
   */
  it("refuses anything else, including a host that merely contains the letters", () => {
    for (const url of [
      "https://api.example.org",
      "https://example.org",
      "https://notstagingatall.example.org",
      "https://api.prod.example.org",
      "https://192.168.1.10",
      "not a url at all",
    ]) {
      expect(requiresProductionOptIn(url), url).toBe(true);
    }
  });
});

describe("refusals", () => {
  it("passes a complete, non-production invocation", () => {
    expect(refusals(complete)).toEqual([]);
  });

  it("requires a base URL, a namespace and a credential", () => {
    expect(refusals({}).length).toBe(3);
    expect(refusals({ ...complete, baseUrl: undefined })[0]).toMatch(/--base-url/);
    expect(refusals({ ...complete, namespace: undefined })[0]).toMatch(/--namespace/);
    expect(refusals({ ...complete, privyToken: undefined })[0]).toMatch(/--privy-token/);
  });

  it("accepts an API key in place of a session", () => {
    expect(refusals({ ...complete, privyToken: undefined, apiKey: "rfph_x" })).toEqual([]);
  });

  it("holds the namespace to the slug shape ids are held to", () => {
    for (const namespace of ["My-Org", "my org", "my_org", "-my-org", "my--org"]) {
      expect(refusals({ ...complete, namespace })[0], namespace).toMatch(/slug/);
    }
  });

  it("refuses a production-looking target until it is named explicitly", () => {
    const production = { ...complete, baseUrl: "https://api.example.org" };
    expect(refusals(production)[0]).toMatch(/--allow-production/);
    expect(refusals({ ...production, allowProduction: true })).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("reads the flags a run needs", () => {
    const opts = parseArgs([
      "--base-url",
      "http://localhost:3001",
      "--namespace",
      "my-org",
      "--privy-token",
      "abc",
      "--admin-token",
      "def",
      "--views",
      "9",
      "--allow-production",
      "--keep-fixtures",
    ]);
    expect(opts).toMatchObject({
      baseUrl: "http://localhost:3001",
      namespace: "my-org",
      privyToken: "abc",
      adminToken: "def",
      views: 9,
      allowProduction: true,
      keepFixtures: true,
    });
  });

  it("falls back to the credential environment variables, but never over a flag", () => {
    const env = {
      M3_PRIVY_TOKEN: "from-env",
      M3_ADMIN_TOKEN: "admin-from-env",
      M3_API_KEY: "rfph_from_env",
    };
    const fromEnv = parseArgs(["--base-url", "http://127.0.0.1:3001"], env);
    expect(fromEnv).toMatchObject({
      privyToken: "from-env",
      adminToken: "admin-from-env",
      apiKey: "rfph_from_env",
    });

    const flagWins = parseArgs(["--privy-token", "from-flag"], env);
    expect(flagWins.privyToken).toBe("from-flag");
    // The other two still fall back — one explicit flag does not disable the mechanism.
    expect(flagWins.adminToken).toBe("admin-from-env");
  });

  it("rejects an unknown flag and a flag with no value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--base-url"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--views", "-3"])).toThrow(/non-negative/);
  });
});
