/**
 * In-browser validation against the Standard, using the workspace's own validator.
 *
 * WHY THE REAL PACKAGE AND NOT A REIMPLEMENTATION. `rfphub-validate` is what the API validates
 * with. A second, hand-written approximation in the frontend would disagree with it eventually,
 * and the disagreement would always land the same way round: a form that says "looks fine" and a
 * server that says 400.
 *
 * WHY IT WORKS UNDER A STRICT CSP, WHICH IS NOT OBVIOUS AND WAS ONCE UNTRUE.
 *
 * ajv normally turns a JSON Schema into a function with `new Function`, and this page's
 * Content-Security-Policy has no `'unsafe-eval'` (`lib/csp.ts`), so that call throws `EvalError` in
 * the browser. For a window between the auth migration and the fix, that is exactly what happened
 * here and the form ran with no in-browser validation at all.
 *
 * It is fixed at the source rather than by relaxing the header: `rfphub-validate` now ships the
 * Standard's validator PRECOMPILED with ajv's standalone code generator, and `validateOpportunity`
 * resolves straight to it — no schema is compiled at runtime, so nothing on this path evaluates a
 * string. Verified by making `Function` throw and watching validation still return both a pass and a
 * humanized failure.
 *
 * ajv's compiler is nevertheless still PRESENT in the bundle: `ajv-formats` requires `ajv`
 * unconditionally and declares no `sideEffects: false`, so a bundler keeps the machinery even
 * though the only call site (`createValidator` with a caller-supplied schema) is unreachable from
 * here. Present but never executed is the accurate description; "the bundle contains no
 * `new Function`" is not, and a grep for it will find one.
 *
 * THE `try` STAYS, AS DEFENCE IN DEPTH RATHER THAN AS THE EXPECTED PATH. It costs nothing and it
 * still catches the cases that remain real — a future schema change that reintroduces runtime
 * compilation, a browser extension imposing a stricter policy than ours, a malformed document that
 * makes a check throw. When it fires, the form reports validation "unavailable" rather than "valid":
 * it says so on screen and submits anyway, and the API's own humanized 400 lands in the same place.
 * Degraded, honest, and never a false all-clear.
 */
import { humanizeErrors, validateOpportunity } from "rfphub-validate";

export type ClientValidation =
  | {
      available: true;
      /** Hard schema violations, one human sentence each. Empty means conformant. */
      errors: string[];
      /** Advisory check-tier findings. A conformant document may carry these. */
      warnings: string[];
    }
  | { available: false; reason: string };

export function validateDocument(document: unknown): ClientValidation {
  try {
    const result = validateOpportunity(document, { checks: true });
    return {
      available: true,
      errors: result.valid ? [] : humanizeErrors(result.errors, document),
      warnings: result.warnings.map((warning) => warning.message),
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? `In-browser validation is unavailable in this browser (${error.message}). The API will still validate this submission.`
          : "In-browser validation is unavailable in this browser. The API will still validate this submission.",
    };
  }
}
