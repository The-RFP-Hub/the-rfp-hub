import { type Opportunity, SPEC_VERSION, opportunitySchema } from "@rfp-hub/standard";
import addFormats from "ajv-formats";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export interface ValidateOptions {
  /** Spec version to validate against. Only the bundled version is supported. */
  spec?: string;
  /** Inject a pre-compiled validator (e.g. to validate against a custom schema). */
  validator?: ValidateFunction;
}

/**
 * Compile an ajv validator. Uses the SAME configuration the standard is authored
 * against: draft 2020-12, strict mode, `strictRequired` off (so the conditional
 * type-block pattern — `opportunity[opportunity.type]` — is permitted).
 */
export function createValidator(
  schema: Record<string, unknown> = opportunitySchema as Record<string, unknown>,
): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

let _default: ValidateFunction | undefined;
function defaultValidator(): ValidateFunction {
  if (!_default) _default = createValidator();
  return _default;
}

function resolveValidator(opts: ValidateOptions): ValidateFunction {
  if (opts.validator) return opts.validator;
  if (opts.spec && opts.spec !== SPEC_VERSION) {
    throw new Error(`unsupported spec '${opts.spec}' (this build ships ${SPEC_VERSION})`);
  }
  return defaultValidator();
}

/** Validate arbitrary data against the RFP Hub Standard. */
export function validateOpportunity(data: unknown, opts: ValidateOptions = {}): ValidationResult {
  const validate = resolveValidator(opts);
  const valid = validate(data);
  return { valid, errors: valid ? [] : (validate.errors ?? []) };
}

/** Assert that data is a valid Opportunity, narrowing its type. Throws otherwise. */
export function assertOpportunity(
  data: unknown,
  opts: ValidateOptions = {},
): asserts data is Opportunity {
  const { valid, errors } = validateOpportunity(data, opts);
  if (!valid) {
    const summary = errors.map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
    const err = new Error(`invalid opportunity: ${summary}`) as Error & { errors?: ErrorObject[] };
    err.errors = errors;
    throw err;
  }
}

export { SPEC_VERSION };
