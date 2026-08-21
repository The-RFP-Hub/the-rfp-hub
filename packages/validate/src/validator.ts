import { type Opportunity, SPEC_VERSION, opportunitySchema } from "@the-rfp-hub/standard";
import addFormats from "ajv-formats";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { type Warning, runChecks } from "./checks/index.js";
import { humanizeErrors } from "./errors.js";
import { opportunity as generatedOpportunityValidator } from "./generated/validators.js";

export interface ValidationResult {
  /** Schema conformance. Advisory warnings never affect this. */
  valid: boolean;
  /** Hard schema violations. A document with any of these is not conformant. */
  errors: ErrorObject[];
  /**
   * Advisory findings from the check tier — quality signal about things the schema
   * deliberately leaves open (unregistered vocabulary values, cross-object rules JSON Schema
   * cannot express). A conformant document may still carry warnings.
   */
  warnings: Warning[];
}

export interface ValidateOptions {
  /** Spec version to validate against. Only the bundled version is supported. */
  spec?: string;
  /** Inject a pre-compiled validator (e.g. to validate against a custom schema). */
  validator?: ValidateFunction;
  /** Run the advisory check tier. Default true. */
  checks?: boolean;
}

/** Annotation keywords the standard uses. Declared so ajv's strict mode accepts them. */
const ANNOTATION_KEYWORDS = ["x-stability", "x-since", "x-deprecated"];

/**
 * Compile an ajv validator for a caller-supplied schema at runtime. Uses the SAME configuration
 * the standard is authored against: draft 2020-12, strict mode, `strictRequired` off (so
 * applicator subschemas — the binding `allOf`, the deadline `if`/`then` — may require properties
 * they re-reference rather than declare).
 *
 * `ajv.compile` generates source and calls `new Function` on it, which throws under a strict CSP
 * with no `unsafe-eval` — there is no way around that for a schema unknown until runtime. The
 * standard's OWN schema doesn't pay that cost: createValidator() below returns a validator
 * precompiled at build time instead of calling this. Kept as its own function, rather than inlined
 * into createValidator's fallback branch, so nothing on the hot `validateOpportunity` path
 * references it directly — `resolveValidator()` never calls createValidator() at all. This is
 * NOT a guarantee that a downstream bundler drops this function's `ajv`/`ajv-formats` compile
 * machinery for a consumer that never calls createValidator with a custom schema: ajv-formats'
 * own `require("ajv")` inside its `limit.js` is unconditional and its package.json does not
 * declare `sideEffects: false`, so a bundler that merely sees `import addFormats from
 * "ajv-formats"` in a loaded module — even one whose call site is dead — will typically keep it.
 * It is still unreachable at runtime: nothing here ever invokes it for the standard's own schema.
 */
function compileCustomValidator(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword(keyword);
  return ajv.compile(schema);
}

/**
 * Get a validator for `schema`. Defaults to — and for an explicit `opportunitySchema` passed back
 * in, still returns — the standard's own precompiled validator (see scripts/codegen.mjs); a
 * genuinely custom schema falls back to compiling one now, via compileCustomValidator(), which is
 * unavailable under a strict CSP with no `unsafe-eval`.
 */
export function createValidator(
  schema: Record<string, unknown> = opportunitySchema as Record<string, unknown>,
): ValidateFunction {
  // A DISTINCT wrapper per call, never the generated singleton itself. ajv reports errors by
  // MUTATING `.errors` on the validator function, so every caller handed the same function object
  // shares one error slot: A validates an invalid document, B validates a valid one, A then reads
  // `A.errors` and sees B's null. Main's behaviour — a fresh compiled validator per call — kept
  // callers isolated, and this wrapper preserves that contract over the shared precompiled
  // engine. Delegation plus the copy is synchronous, so two interleaved calls cannot tear it.
  if (schema === opportunitySchema) {
    const wrapper = ((data: unknown) => {
      const valid = generatedOpportunityValidator(data);
      wrapper.errors = generatedOpportunityValidator.errors;
      return valid;
    }) as ValidateFunction;
    return wrapper;
  }
  return compileCustomValidator(schema);
}

function resolveValidator(opts: ValidateOptions): ValidateFunction {
  if (opts.validator) return opts.validator;
  if (opts.spec && opts.spec !== SPEC_VERSION) {
    throw new Error(`unsupported spec '${opts.spec}' (this build ships ${SPEC_VERSION})`);
  }
  return generatedOpportunityValidator;
}

/** Validate arbitrary data against the RFP Hub Standard, plus the advisory check tier. */
export function validateOpportunity(data: unknown, opts: ValidateOptions = {}): ValidationResult {
  const validate = resolveValidator(opts);
  const valid = validate(data);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []),
    warnings: opts.checks === false ? [] : runChecks(data),
  };
}

/** Assert that data is a valid Opportunity, narrowing its type. Throws otherwise. */
export function assertOpportunity(
  data: unknown,
  opts: ValidateOptions = {},
): asserts data is Opportunity {
  const { valid, errors } = validateOpportunity(data, { ...opts, checks: false });
  if (!valid) {
    const summary = humanizeErrors(errors, data).join("; ");
    const err = new Error(`invalid opportunity: ${summary}`) as Error & { errors?: ErrorObject[] };
    err.errors = errors;
    throw err;
  }
}

export { SPEC_VERSION };
