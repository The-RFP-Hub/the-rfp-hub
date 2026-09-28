/**
 * The rule this allowlist replaced asked whether a hostname segment read like a non-production
 * environment, which admits `not-staging-anymore.example.org` and any CNAME whoever controls DNS
 * points wherever they like.
 */
import { describe, expect, it, vi } from "vitest";
import {
  STAGING_ORIGINS,
  allowedOrigins,
  normalizeOrigin,
  targetRefusal,
} from "../target-guard.mjs";

describe("normalizeOrigin", () => {
  it("keeps scheme, host and a non-default port, and lower-cases the host", () => {
    expect(normalizeOrigin("HTTPS://Staging.RfpSear.CH/v1/")?.origin).toBe(
      "https://staging.rfpsear.ch",
    );
    expect(normalizeOrigin("https://staging.rfpsear.ch:8443")?.origin).toBe(
      "https://staging.rfpsear.ch:8443",
    );
    expect(normalizeOrigin("https://staging.rfpsear.ch:443")?.origin).toBe(
      "https://staging.rfpsear.ch",
    );
  });

  it("refuses userinfo, a non-http scheme, a trailing-dot host and anything unparseable", () => {
    expect(normalizeOrigin("https://user:pass@staging.rfpsear.ch")).toBeNull();
    expect(normalizeOrigin("ftp://staging.rfpsear.ch")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("https://staging.rfpsear.ch.")?.host).toBe("staging.rfpsear.ch");
  });
});

describe("allowedOrigins", () => {
  it("is the project's staging origins, and takes nothing that could widen them", () => {
    expect(allowedOrigins()).toEqual(STAGING_ORIGINS);
    // The previous design read one extra origin out of a variable, which put "where may live
    // credentials be sent" in somebody's shell rather than in a reviewed commit. Nothing is read
    // at run time now: an argument is ignored, and an origin that is not on the list is refused.
    expect(allowedOrigins({ ANY_VARIABLE: "https://api-staging.example.org" })).toEqual(
      STAGING_ORIGINS,
    );
    expect(targetRefusal("https://api-staging.example.org")).toContain(
      "not an allowed write target",
    );
  });

  it("names editing the constant as the way a fork adds its own staging origin", () => {
    expect(targetRefusal("https://api-staging.example.org")).toContain("STAGING_ORIGINS");
  });
});

describe("targetRefusal", () => {
  it("allows loopback, plaintext included: that traffic never leaves the machine", () => {
    for (const api of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
      expect(targetRefusal(api), api).toBeNull();
    }
  });

  it("allows the allowlisted staging origins", () => {
    for (const api of STAGING_ORIGINS) expect(targetRefusal(api), api).toBeNull();
  });

  it("names production as production, and offers no way to force it", () => {
    const reason = targetRefusal("https://api.rfpsear.ch");
    expect(reason).toContain("is PRODUCTION");
    expect(reason).toContain("There is no flag and no variable that forces production");
  });

  it("still treats the pre-move hostnames as the same deployments (adr/0013)", () => {
    expect(targetRefusal("https://api.ethrfps.app")).toContain("is PRODUCTION");
    expect(targetRefusal("https://api-staging.ethrfps.app")).toBeNull();
  });

  // Every one of these was ACCEPTED by the hostname heuristic this allowlist replaced.
  it("refuses everything the segment-wise heuristic used to let through", () => {
    for (const api of [
      "https://api.rfpsear.ch",
      "https://API.ETHRFPS.APP",
      "https://api.rfpsear.ch.",
      "https://rfpsear.ch",
      "https://104.21.1.2",
      "https://not-staging-anymore.example.org",
      "https://production-staging.example.org",
      "https://staging.api.rfpsear.ch.example.org",
      "https://api-staging.example.org",
      // Derived, never written out: a plaintext URL on this project's own domain is a neutrality
      // violation wherever it appears, including in a test that exists to refuse it.
      STAGING_ORIGINS[0].replace("https:", "http:"),
      "ftp://api-staging.rfpsear.ch",
    ]) {
      expect(targetRefusal(api), api).toEqual(expect.any(String));
    }
  });

  it("resolves the default port rather than reading it as a different origin", () => {
    expect(targetRefusal("https://api-staging.rfpsear.ch:443")).toBeNull();
  });

  it("says plainly that it sends live credentials, so plaintext is loopback-only", () => {
    expect(targetRefusal("http://api-staging.example.org")).toContain("live credentials");
  });

  it("refuses remote plaintext, an unparseable target and userinfo", () => {
    expect(targetRefusal("http://api-staging.example.org")).toContain("not https");
    expect(targetRefusal("not a url")).toContain("must be an absolute http(s) URL");
    expect(targetRefusal("https://a:b@staging.rfpsear.ch")).toContain("no userinfo");
  });
});

describe("redirectRefusal", () => {
  // An allowlisted origin that 302s elsewhere still receives the request carrying the credential.
  it("refuses when a hop lands outside the allowlist", async () => {
    vi.resetModules();
    vi.doMock("../http.mjs", () => ({
      isLoopbackHost: () => false,
      request: async () => ({
        ok: true,
        status: 302,
        location: "https://api.rfpsear.ch/v1/health",
      }),
    }));
    const { redirectRefusal } = await import("../target-guard.mjs");
    const reason = await redirectRefusal("https://staging.rfpsear.ch");
    expect(reason).toContain("redirects to https://api.rfpsear.ch");
    expect(reason).toContain("is PRODUCTION");
    vi.doUnmock("../http.mjs");
    vi.resetModules();
  });

  it("refuses a chain that never settles", async () => {
    vi.resetModules();
    vi.doMock("../http.mjs", () => ({
      isLoopbackHost: () => false,
      request: async () => ({
        ok: true,
        status: 302,
        location: "https://staging.rfpsear.ch/v1/health",
      }),
    }));
    const { redirectRefusal } = await import("../target-guard.mjs");
    expect(await redirectRefusal("https://staging.rfpsear.ch")).toContain(
      "redirects more than 5 times",
    );
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
    expect(await redirectRefusal("https://staging.rfpsear.ch")).toBeNull();
    vi.doUnmock("../http.mjs");
    vi.resetModules();
  });
});
