/**
 * What `RFPHUB_API_BASE` and `RFPHUB_MCP_TIMEOUT_MS` are allowed to be.
 *
 * The base is not merely a URL: the write path sends a bearer credential to it, and the approval a
 * human grants binds its ORIGIN. So a base that puts the credential in cleartext, hides one inside
 * the URL, or carries a path the origin binding cannot see has to be refused at startup — before a
 * preview exists for anyone to approve.
 */
import { describe, expect, it } from "vitest";
import { computeApprovalId, documentHashOf } from "../src/approvals.js";
import {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  canonicalOrigin,
  loadConfig,
  resolveTimeoutMs,
} from "../src/config.js";

function load(env: Record<string, string>) {
  return loadConfig(env as NodeJS.ProcessEnv);
}

describe("the API base must be https, or loopback", () => {
  it("accepts https for any host", () => {
    expect(canonicalOrigin("https://api.ethrfps.app")).toBe("https://api.ethrfps.app");
    expect(canonicalOrigin("https://staging.example.test:8443")).toBe(
      "https://staging.example.test:8443",
    );
  });

  it("accepts plain http for the three loopback forms, including a trailing dot", () => {
    expect(canonicalOrigin("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(canonicalOrigin("http://[::1]:5000")).toBe("http://[::1]:5000");
    expect(canonicalOrigin("http://localhost:5000")).toBe("http://localhost:5000");
    expect(canonicalOrigin("http://localhost.:5000")).toBe("http://localhost.:5000");
    expect(canonicalOrigin("http://LOCALHOST:5000")).toBe("http://localhost:5000");
  });

  it("refuses plain http for anything else, and names the rule", () => {
    expect(() => canonicalOrigin("http://api.ethrfps.app")).toThrow(ConfigError);
    expect(() => canonicalOrigin("http://api.ethrfps.app")).toThrow(/must use https/);
    // Not loopback, however much it looks like it.
    expect(() => canonicalOrigin("http://127.0.0.1.evil.test")).toThrow(/must use https/);
    expect(() => canonicalOrigin("http://localhost.evil.test")).toThrow(/must use https/);
    expect(() => canonicalOrigin("http://10.0.0.1")).toThrow(/must use https/);
  });

  it("refuses a scheme that is neither", () => {
    expect(() => canonicalOrigin("file:///etc/passwd")).toThrow(/must be http or https/);
  });

  it("refuses embedded credentials without ever echoing them", () => {
    const secret = "s3cr3t-password-in-the-url";
    let message = "";
    try {
      canonicalOrigin(`https://someone:${secret}@api.example.test`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/must not carry a username or password/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("someone");
  });

  it("refuses a path, a query or a fragment, because the approval binds only the origin", () => {
    expect(() => canonicalOrigin("https://api.example.test/v2")).toThrow(/bare origin/);
    expect(() => canonicalOrigin("https://api.example.test/?tenant=a")).toThrow(/bare origin/);
    expect(() => canonicalOrigin("https://api.example.test/#x")).toThrow(/bare origin/);
  });

  it("does not repeat an unparseable value, which may itself be a credential", () => {
    let message = "";
    try {
      canonicalOrigin("not a url with a-secret-inside");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not a valid absolute URL/);
    expect(message).not.toContain("a-secret-inside");
  });
});

describe("origin canonicalization keeps one approval per destination", () => {
  it("gives a trailing slash, an explicit default port and an upper-case host one digest", () => {
    const document = documentHashOf({ id: "example-org:x" });
    const digest = (base: string) =>
      computeApprovalId({
        apiOrigin: load({ RFPHUB_API_BASE: base }).apiOrigin,
        keyFingerprint: "none",
        operation: "submit_opportunity",
        protocolVersion: "2026-07-28",
        documentHash: document,
      });

    const canonical = digest("https://api.ethrfps.app");
    expect(digest("https://api.ethrfps.app/")).toBe(canonical);
    expect(digest("https://api.ethrfps.app:443")).toBe(canonical);
    expect(digest("https://API.ethrfps.APP")).toBe(canonical);
    expect(digest("https://api.ethrfps.app:444")).not.toBe(canonical);
  });

  it("normalizes apiBase to the same origin the approval binds", () => {
    const config = load({ RFPHUB_API_BASE: "https://API.ethrfps.app:443/" });
    expect(config.apiBase).toBe("https://api.ethrfps.app");
    expect(config.apiBase).toBe(config.apiOrigin);
  });
});

describe("the request deadline", () => {
  it("defaults, and accepts a value inside the bounds", () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("  ")).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("2500")).toBe(2_500);
    expect(load({}).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(load({ RFPHUB_MCP_TIMEOUT_MS: "3000" }).timeoutMs).toBe(3_000);
  });

  it("refuses anything that would remove or corrupt the bound", () => {
    for (const value of ["0", "-1", "abc", "1.5", "Infinity", String(MAX_TIMEOUT_MS + 1)]) {
      expect(() => resolveTimeoutMs(value), value).toThrow(ConfigError);
    }
  });
});

describe("RFPHUB_MCP_HOME wins", () => {
  it("takes precedence over the user's home directory", () => {
    const config = load({ RFPHUB_MCP_HOME: "/tmp/somewhere-else", HOME: "/home/someone" });
    expect(config.home).toBe("/tmp/somewhere-else");
  });
});
