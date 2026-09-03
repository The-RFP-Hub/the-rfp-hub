/**
 * The allowlist that decides which deployments may be written to.
 *
 * The rule it replaced asked whether any hostname segment read like a non-production environment,
 * which admits `not-staging-anymore.example.org`, `production-staging.example.org` and any CNAME
 * whoever controls DNS points wherever they like. Hostname text cannot prove which deployment
 * answers, so this is an explicit list plus a redirect chain that is re-checked at every hop.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EXTRA_ORIGIN_ENV,
  STAGING_ORIGINS,
  allowedOrigins,
  namesStaging,
  normalizeOrigin,
  targetRefusal,
} from "../target-guard.mjs";

describe("normalizeOrigin", () => {
  it("keeps scheme, host and a non-default port, and lower-cases the host", () => {
    expect(normalizeOrigin("HTTPS://Staging.EthRfps.App/v1/")?.origin).toBe(
      "https://staging.ethrfps.app",
    );
    expect(normalizeOrigin("https://staging.ethrfps.app:8443")?.origin).toBe(
      "https://staging.ethrfps.app:8443",
    );
    expect(normalizeOrigin("https://staging.ethrfps.app:443")?.origin).toBe(
      "https://staging.ethrfps.app",
    );
  });

  it("refuses userinfo, a non-http scheme, a trailing-dot host and anything unparseable", () => {
    expect(normalizeOrigin("https://user:pass@staging.ethrfps.app")).toBeNull();
    expect(normalizeOrigin("ftp://staging.ethrfps.app")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("https://staging.ethrfps.app.")?.host).toBe("staging.ethrfps.app");
  });
});

describe("namesStaging", () => {
  it("wants a whole label, not a substring", () => {
    expect(namesStaging("staging.example.org")).toBe(true);
    expect(namesStaging("api-staging.example.org")).toBe(true);
    expect(namesStaging("staging-api.example.org")).toBe(true);
    expect(namesStaging("notstagingatall.example.org")).toBe(false);
  });

  it("a `prod` label vetoes it: saying staging as well does not make it staging", () => {
    expect(namesStaging("staging.prod.example.org")).toBe(false);
    expect(namesStaging("production-staging.example.org")).toBe(false);
  });
});

describe("allowedOrigins", () => {
  it("is the project's staging origins by default", () => {
    expect(allowedOrigins({})).toEqual(STAGING_ORIGINS);
  });

  it("takes one https, staging-named extra from the environment", () => {
    expect(allowedOrigins({ [EXTRA_ORIGIN_ENV]: "https://api-staging.example.org" })).toContain(
      "https://api-staging.example.org",
    );
  });

  it("will not be extended with production, plaintext, or a host that only sounds like staging", () => {
    for (const value of [
      "https://api.ethrfps.app",
      "http://api-staging.example.org",
      "https://notstagingatall.example.org",
      "https://staging.prod.example.org",
    ]) {
      expect(allowedOrigins({ [EXTRA_ORIGIN_ENV]: value }), value).toEqual(STAGING_ORIGINS);
    }
  });
});

describe("targetRefusal", () => {
  it("allows loopback, plaintext included: that traffic never leaves the machine", () => {
    for (const api of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
      expect(targetRefusal(api, {}), api).toBeNull();
    }
  });

  it("allows the allowlisted staging origins", () => {
    for (const api of STAGING_ORIGINS) expect(targetRefusal(api, {}), api).toBeNull();
  });

  it("names production as production, and offers no way to force it", () => {
    const reason = targetRefusal("https://api.ethrfps.app", {});
    expect(reason).toContain("is PRODUCTION");
    expect(reason).toContain("There is no flag to force production");
  });

  it("refuses remote plaintext, an unparseable target and userinfo", () => {
    expect(targetRefusal("http://api-staging.example.org", {})).toContain("not https");
    expect(targetRefusal("not a url", {})).toContain("must be an absolute http(s) URL");
    expect(targetRefusal("https://a:b@staging.ethrfps.app", {})).toContain("no userinfo");
  });
});

describe("redirectRefusal", () => {
  /**
   * The hop is what the hostname rules cannot see: an allowlisted origin that 302s somewhere else
   * still receives the request that carries the credential.
   */
  it("refuses when a hop lands outside the allowlist", async () => {
    vi.resetModules();
    vi.doMock("../http.mjs", () => ({
      isLoopbackHost: () => false,
      request: async () => ({
        ok: true,
        status: 302,
        location: "https://api.ethrfps.app/v1/health",
      }),
    }));
    const { redirectRefusal } = await import("../target-guard.mjs");
    const reason = await redirectRefusal("https://staging.ethrfps.app", { env: {} });
    expect(reason).toContain("redirects to https://api.ethrfps.app");
    expect(reason).toContain("is PRODUCTION");
    vi.doUnmock("../http.mjs");
    vi.resetModules();
  });

  it("is silent when nothing redirects", async () => {
    vi.resetModules();
    vi.doMock("../http.mjs", () => ({
      isLoopbackHost: () => false,
      request: async () => ({ ok: true, status: 200 }),
    }));
    const { redirectRefusal } = await import("../target-guard.mjs");
    expect(await redirectRefusal("https://staging.ethrfps.app", { env: {} })).toBeNull();
    vi.doUnmock("../http.mjs");
    vi.resetModules();
  });
});
