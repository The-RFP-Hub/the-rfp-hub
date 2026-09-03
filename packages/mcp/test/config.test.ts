/**
 * What `RFPHUB_API_BASE` is allowed to be, and where local state lands.
 *
 * The base is not merely a URL: the write path sends a bearer credential to it, and the approval a
 * human grants binds its ORIGIN. So a base that puts the credential in cleartext, hides one inside
 * the URL, or carries a path the origin binding cannot see has to be refused at startup — before a
 * preview exists for anyone to approve.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeApprovalId, documentHashOf } from "../src/approvals.js";
import {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  canonicalOrigin,
  cliCommand,
  defaultStateDir,
  loadConfig,
  shellQuote,
} from "../src/config.js";

function load(env: Record<string, string>, options: { stateDir?: string } = {}) {
  return loadConfig(env as NodeJS.ProcessEnv, options);
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
    expect(() => canonicalOrigin("http://api.example.test")).toThrow(ConfigError);
    expect(() => canonicalOrigin("http://api.example.test")).toThrow(/must use https/);
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
  it("is a constant, so nothing can raise it or take it away", () => {
    expect(load({}).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("the state directory", () => {
  it("defaults under the user's home when --state-dir is absent", () => {
    expect(load({}).home).toBe(defaultStateDir());
    expect(defaultStateDir().endsWith(path.join(path.sep, ".rfphub"))).toBe(true);
  });

  it("takes the flag when it is given, and makes a relative path absolute", () => {
    expect(load({}, { stateDir: "/tmp/somewhere-else" }).home).toBe("/tmp/somewhere-else");
    expect(load({}, { stateDir: "  /tmp/padded  " }).home).toBe("/tmp/padded");
    expect(load({}, { stateDir: "state" }).home).toBe(path.resolve("state"));
  });

  it("records that the flag was given, rather than leaving it to be inferred later", () => {
    expect(load({}).stateDirExplicit).toBe(false);
    expect(load({}, { stateDir: "/tmp/x" }).stateDirExplicit).toBe(true);
    // An empty or blank flag value is refused by the CLI parser, so it never reaches here as one.
    expect(load({}, { stateDir: "   " }).stateDirExplicit).toBe(false);
  });

  it("does NOT resolve the default when the flag is given", () => {
    // An identity with no home and no passwd entry — a container UID — makes `os.homedir()` throw.
    // That is precisely the case `--state-dir` exists for, so nothing may consult the default.
    const spy = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("uv_os_homedir returned ENOENT");
    });
    try {
      const config = load({}, { stateDir: "/var/lib/rfphub" });
      expect(config.home).toBe("/var/lib/rfphub");
      expect(cliCommand(config, "pending")).toBe("rfphub-mcp --state-dir /var/lib/rfphub pending");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the environment surface", () => {
  it("reads exactly two variables, and would notice a third being added", () => {
    // A Proxy rather than a list of names: the assertion is over what the code TOUCHES, so a
    // variable reintroduced anywhere in `loadConfig` fails here without anyone remembering to.
    const seen: string[] = [];
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_target, property) {
        if (typeof property === "string") seen.push(property);
        return undefined;
      },
    });
    loadConfig(env, { stateDir: "/tmp/state" });
    expect([...new Set(seen)].sort()).toEqual(["RFPHUB_API_BASE", "RFPHUB_API_KEY"]);
  });
});

describe("shellQuote", () => {
  it("leaves an ordinary path bare", () => {
    for (const value of ["/var/lib/rfphub", "state", "/tmp/a-b_c.d", "/home/user/.rfphub"]) {
      expect(shellQuote(value), value).toBe(value);
    }
  });

  it("quotes a path a shell would otherwise split or expand", () => {
    expect(shellQuote("/tmp/my state")).toBe("'/tmp/my state'");
    expect(shellQuote("/tmp/$HOME")).toBe("'/tmp/$HOME'");
    expect(shellQuote("/tmp/a;rm -rf b")).toBe("'/tmp/a;rm -rf b'");
    expect(shellQuote("/tmp/`whoami`")).toBe("'/tmp/`whoami`'");
    expect(shellQuote("")).toBe("''");
  });

  it("closes, escapes and reopens around a single quote — the one case quoting cannot cover", () => {
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
  });

  it("quotes a value that would otherwise read as a flag", () => {
    expect(shellQuote("--state-dir")).toBe("'--state-dir'");
  });
});

describe("cliCommand", () => {
  it("omits the flag when the state directory is the default", () => {
    expect(
      cliCommand({ home: "/home/someone/.rfphub", stateDirExplicit: false }, "approve", "x"),
    ).toBe("rfphub-mcp approve x");
  });

  it("carries the flag, quoted, when one was given", () => {
    expect(cliCommand({ home: "/tmp/my state", stateDirExplicit: true }, "approve", "x")).toBe(
      "rfphub-mcp --state-dir '/tmp/my state' approve x",
    );
  });
});
