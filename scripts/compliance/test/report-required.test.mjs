/**
 * A REQUIRED check that could not be performed must not produce a green run. `--only frontend`
 * without `--browser` printed RESULT: PASS and exited 0 with nine browser checks at WARN, because
 * a criterion with warnings passes.
 */
import { describe, expect, it } from "vitest";
import { describeScope } from "../options.mjs";
import { Report } from "../report.mjs";

function report(meta = {}) {
  return new Report({ siteUrl: "https://site.example", baseUrl: "https://api.example", ...meta });
}

describe("a required check that could not be performed", () => {
  it("makes its criterion INCOMPLETE and the run non-green", () => {
    const r = report();
    const c = r.criterion("x", "x", "d");
    c.pass("something real");
    c.unmet("needs a browser", "needs --browser");
    c.finish();
    expect(c.status).toBe("incomplete");
    expect(r.result).toBe("incomplete");
    expect(r.ok).toBe(false);
  });

  it("is listed by name, so the report says WHICH requirement is unmet", () => {
    const r = report();
    const c = r.criterion("x", "x", "d");
    c.unmet("rendered slugs equal the API's", "needs --browser");
    expect(c.unmetChecks).toEqual(["rendered slugs equal the API's"]);
  });

  it("a plain warn still passes — the check HELD, but see this", () => {
    const r = report();
    const c = r.criterion("x", "x", "d");
    c.pass("held");
    c.warn("TLS certificate lifetime", "only 9 day(s) remaining");
    c.finish();
    expect(c.status).toBe("warn");
    expect(r.result).toBe("pass");
  });

  it("unmet blocks the run; a plain skip is the optional one and stays green", () => {
    const required = report();
    const a = required.criterion("x", "x", "d");
    a.pass("held");
    a.unmet("--skip x", "asked for");
    expect(required.result).toBe("incomplete");

    const optional = report();
    const b = optional.criterion("x", "x", "d");
    b.pass("held");
    b.skip("TLS certificate is valid", "loopback origin, no transport to inspect");
    expect(optional.result).toBe("pass");
  });

  it("a failure still outranks an unmet requirement", () => {
    const r = report();
    const c = r.criterion("x", "x", "d");
    c.fail("broken", "no");
    c.unmet("unchecked", "needs --browser");
    expect(c.status).toBe("fail");
    expect(r.result).toBe("fail");
  });
});

describe("scoped runs", () => {
  it("names --only docs --offline as a docs lint, never a deployment sign-off", () => {
    const label = describeScope({ only: new Set(["docs"]), skip: new Set(), offline: true });
    expect(label).toContain("docs lint, offline");
    expect(label).toContain("NOT a deployment sign-off");
  });

  it("is undefined for a full run", () => {
    expect(describeScope({ only: new Set(), skip: new Set(), offline: false })).toBeUndefined();
  });

  it("never renders the bare RESULT: PASS headline", () => {
    const r = report({
      scopeLabel: "docs lint, offline — NOT a deployment sign-off (--only docs)",
    });
    r.criterion("docs", "docs", "d").pass("held").finish();
    const rendered = r.render();
    expect(rendered).toContain("RESULT: SCOPED PASS");
    expect(rendered).not.toMatch(/RESULT: PASS/);
    expect(r.toJSON().signOff).toBe(false);
  });

  it("an unscoped green run is a sign-off", () => {
    const r = report();
    r.criterion("docs", "docs", "d").pass("held").finish();
    expect(r.toJSON().signOff).toBe(true);
    expect(r.render()).toContain("RESULT: PASS");
  });
});
