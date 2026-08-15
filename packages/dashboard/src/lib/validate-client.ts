/**
 * In-browser validation against the Standard, using the workspace's own validator.
 *
 * WHY THE REAL PACKAGE AND NOT A REIMPLEMENTATION. `rfphub-validate` is what the API validates
 * with. A second, hand-written approximation in the dashboard would disagree with it eventually,
 * and the disagreement would always land the same way round: a form that says "looks fine" and a
 * server that says 400.
 *
 * WHY IT CAN FAIL, AND WHAT HAPPENS THEN. ajv compiles a JSON Schema into a function with
 * `new Function`, which a Content-Security-Policy without `'unsafe-eval'` refuses. This deployment
 * allows it (see `lib/csp.ts`), but a host that tightens the header, or a browser extension that
 * does, would make compilation throw. That is caught here and reported as "unavailable" rather than
 * as "valid": the form then submits and renders the API's own humanized 400. Degraded, honest, and
 * never a false all-clear.
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
