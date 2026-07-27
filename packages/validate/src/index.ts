export {
  validateOpportunity,
  assertOpportunity,
  createValidator,
  SPEC_VERSION,
  type ValidationResult,
  type ValidateOptions,
} from "./validator.js";
export { humanizeError, humanizeErrors } from "./errors.js";
export { checks, runChecks, entryPhrase, type Check, type Warning } from "./checks/index.js";
export type { Opportunity } from "@the-rfp-hub/standard";
