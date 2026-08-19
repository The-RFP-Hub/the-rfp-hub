/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * Tightening the Content-Security-Policy removed `'unsafe-eval'`, and ajv compiles a JSON Schema by
 * calling `new Function` on generated source. For a window, that silently turned the submit form's
 * in-browser validation off in every browser: the form degraded honestly, said so, and leaned on the
 * API's 400 — so nothing crashed, no test failed, and the only symptom was a feature quietly not
 * happening. `test/opportunity-form.test.ts` could not catch it, because it tests the form's field
 * mapping and never calls the validator at all.
 *
 * The fix was to precompile the Standard's validator in `rfphub-validate` rather than to put the
 * relaxation back. These tests hold that fix in place, and the last one is the point: it makes
 * runtime code generation throw — which is precisely what the browser does under this policy — and
 * asserts that validation still returns real answers.
 */
import type { Opportunity } from "@/lib/types";
import { validateDocument } from "@/lib/validate-client";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The real global, captured before any test can replace it, and restored after every one of them.
 * A leaked throwing `Function` would fail later suites in ways that point nowhere near here.
 */
const realFunction = globalThis.Function;
afterEach(() => {
  globalThis.Function = realFunction;
});

const conformant: Opportunity = {
  specVersion: "1.0.0",
  id: "acme:round-1",
  fundingType: "grant",
  title: "Acme Ecosystem Round One",
  description: "Grants for public-goods infrastructure.",
  status: "open",
  operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
  source: {},
  fundingDetails: { fundingType: "grant" },
};

describe("in-browser validation against the Standard", () => {
  it("passes a conformant document with no errors", () => {
    const result = validateDocument(conformant);

    expect(result.available).toBe(true);
    if (result.available) expect(result.errors).toEqual([]);
  });

  it("reports a violation as a humanized sentence rather than a raw ajv error", () => {
    const result = validateDocument({ ...conformant, title: 42 });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.errors.length).toBeGreaterThan(0);
      // The humanizer names the field. A bare "must be string" with no path is what this replaced.
      expect(result.errors.join(" ")).toContain("title");
    }
  });

  it("separates advisory findings from hard violations", () => {
    // A milestone amount with no document-wide currency is conformant but advisory: the check tier
    // warns, and a form that rendered that as an error would block a legal submission.
    const result = validateDocument({
      ...conformant,
      milestones: [{ title: "Testnet", amount: 25000 }],
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.errors).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("RUNS WITH RUNTIME CODE GENERATION BLOCKED, as it must under this page's CSP", () => {
    // `script-src` carries no `'unsafe-eval'`, so a browser throws on `Function(...)`. Simulated
    // here by making the global throw exactly what the browser throws. If this test fails, some
    // change has reintroduced runtime schema compilation and the form has lost live validation in
    // production — even though every other test in this suite would still pass, because jsdom
    // permits eval and the failure is silent by design.
    const blocked = new Proxy(realFunction, {
      apply() {
        throw new EvalError("call to Function() blocked by CSP");
      },
      construct() {
        throw new EvalError("call to Function() blocked by CSP");
      },
    });
    globalThis.Function = blocked as FunctionConstructor;

    const pass = validateDocument(conformant);
    const fail = validateDocument({ ...conformant, title: 42 });

    expect(pass.available).toBe(true);
    if (pass.available) expect(pass.errors).toEqual([]);
    expect(fail.available).toBe(true);
    if (fail.available) expect(fail.errors.length).toBeGreaterThan(0);
  });

  it("reports a failure as unavailable rather than as valid — the degraded path, kept honest", () => {
    // Defence in depth: whatever makes validation throw, the answer must never be "no errors
    // found". That distinction is what stops the form showing a false all-clear.
    const result = validateDocument({
      get specVersion(): never {
        throw new Error("unreadable document");
      },
    });

    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("unavailable");
  });
});
