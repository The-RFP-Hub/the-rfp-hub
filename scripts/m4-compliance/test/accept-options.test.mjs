/**
 * Argument parsing for `scripts/accept-m4.mjs` — in particular `--timeout`, which an earlier
 * revision passed straight through `Number()` with no validation at all, unlike every other
 * numeric flag in this repo's checkers (`--views`/`--timeout`/`--concurrency` in
 * `m3-compliance/options.mjs`, `--timeout`/`--concurrency` in `m4-compliance/options.mjs`), so
 * `--timeout abc` silently became `NaN` and `--timeout -1` was accepted outright.
 */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXTRA_ORIGIN_ENV,
  STAGING_ORIGINS,
  allowedOrigins,
  parseArgs,
  redirectRefusal,
  refusals,
  targetRefusal,
} from "../accept/options.mjs";

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
    api: "https://api-staging.ethrfps.app",
    reviewerToken: "t",
    writeKey: "rfph_x",
  };

  it("passes with api, both credentials, and an allowlisted staging origin", () => {
    expect(refusals(complete, {})).toEqual([]);
  });

  it("requires --api", () => {
    expect(refusals({ ...complete, api: undefined }, {})).toContain("--api is required");
  });

  it("requires both credentials, named individually", () => {
    const reasons = refusals({ ...complete, reviewerToken: undefined, writeKey: undefined }, {});
    expect(reasons.some((r) => r.includes("RFPHUB_REVIEWER_TOKEN"))).toBe(true);
    expect(reasons.some((r) => r.includes("RFPHUB_WRITE_KEY"))).toBe(true);
  });
});

/**
 * The target guard. Every probe below was ACCEPTED by the hostname heuristic this replaced:
 * a segment-wise "does any part read like staging" test admits `not-staging-anymore`,
 * `production-staging` and any CNAME an attacker controls, and `--allow-production` walked past
 * the guard entirely. There is no such flag now, so these are the whole contract.
 */
describe("targetRefusal", () => {
  const allowed = ["https://api-staging.ethrfps.app", "https://staging.ethrfps.app"];
  const loopback = ["http://localhost:3150", "http://127.0.0.1:3150", "http://[::1]:3150"];
  const refused = [
    "https://api.ethrfps.app",
    "https://API.ETHRFPS.APP",
    "https://api.ethrfps.app.",
    "http://api.ethrfps.app",
    "https://ethrfps.app",
    "https://104.21.1.2",
    "https://not-staging-anymore.example.org",
    "https://production-staging.example.org",
    "https://staging.api.ethrfps.app.example.org",
    "https://api-staging.example.org",
    "http://api-staging.ethrfps.app",
    "https://user:pw@api-staging.ethrfps.app",
    "ftp://api-staging.ethrfps.app",
    "not a url",
  ];

  for (const api of [...allowed, ...loopback]) {
    it(`allows ${api}`, () => {
      expect(targetRefusal(api, {})).toBeNull();
    });
  }

  for (const api of refused) {
    it(`refuses ${api}`, () => {
      expect(targetRefusal(api, {})).toEqual(expect.any(String));
    });
  }

  it("names production as production, not merely as unlisted", () => {
    expect(targetRefusal("https://api.ethrfps.app", {})).toContain("PRODUCTION");
  });

  it("resolves the default port rather than treating it as a different origin", () => {
    expect(targetRefusal("https://api-staging.ethrfps.app:443", {})).toBeNull();
  });

  it("says there is no flag to force production", () => {
    expect(targetRefusal("https://api.ethrfps.app", {})).toContain("no flag to force production");
  });
});

describe(`${EXTRA_ORIGIN_ENV} — the only way to add an origin`, () => {
  it("admits an https origin whose hostname carries a staging label", () => {
    const env = { [EXTRA_ORIGIN_ENV]: "https://api-staging.example.org" };
    expect(targetRefusal("https://api-staging.example.org", env)).toBeNull();
  });

  it("does not admit a plaintext origin", () => {
    const env = { [EXTRA_ORIGIN_ENV]: "http://api-staging.example.org" };
    expect(targetRefusal("http://api-staging.example.org", env)).toEqual(expect.any(String));
  });

  it("does not admit a label that also carries prod", () => {
    const env = { [EXTRA_ORIGIN_ENV]: "https://production-staging.example.org" };
    expect(targetRefusal("https://production-staging.example.org", env)).toEqual(
      expect.any(String),
    );
  });

  it("does not admit an origin with no staging label at all", () => {
    const env = { [EXTRA_ORIGIN_ENV]: "https://api.ethrfps.app" };
    expect(targetRefusal("https://api.ethrfps.app", env)).toEqual(expect.any(String));
  });

  it("leaves the built-in allowlist intact", () => {
    expect(allowedOrigins({})).toEqual(STAGING_ORIGINS);
  });
});

describe("--allow-production", () => {
  it("is gone: passing it is an unknown argument, not a force", () => {
    expect(() => parseArgs(["--allow-production"])).toThrow(/unknown argument/);
  });
});

describe("redirectRefusal", () => {
  let server;
  let base;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/v1/health" && req.headers.host?.includes("elsewhere")) {
        res.writeHead(200);
        res.end("{}");
        return;
      }
      if (req.url === "/v1/health") {
        res.writeHead(302, { location: "https://api.ethrfps.app/v1/health" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a loopback target that redirects to production", async () => {
    const reason = await redirectRefusal(base, { timeoutMs: 5000, env: {} });
    expect(reason).toContain("api.ethrfps.app");
    expect(reason).toContain("PRODUCTION");
  });
});
