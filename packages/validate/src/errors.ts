import { opportunitySchema } from "@the-rfp-hub/standard";
import type { ErrorObject, ValidateFunction } from "ajv";
import { createValidator } from "./validator.js";

const schema = opportunitySchema as {
  $schema?: string;
  properties?: Record<string, { enum?: unknown }>;
  $defs?: Record<string, { properties?: Record<string, { const?: unknown }> }>;
};

/**
 * The `fundingType` values, which by the standard's own invariant are exactly the tags of the
 * `fundingDetails` shapes. Read from the schema rather than hardcoded, so a seventh type could
 * never make these messages silently wrong.
 */
const FUNDING_TYPES: readonly string[] = (() => {
  const values = schema.properties?.fundingType?.enum;
  return Array.isArray(values) ? (values as string[]) : [];
})();

/** Tag value → `$defs` name (e.g. 'vc_fund' → 'vcFund'), read from each def's `const` tag. */
const DEF_BY_TAG: ReadonlyMap<string, string> = new Map(
  Object.entries(schema.$defs ?? {}).flatMap(([name, def]) => {
    const tag = def.properties?.fundingType?.const;
    return typeof tag === "string" ? ([[tag, name]] as const) : [];
  }),
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * ajv reports a failed `if`/`then` twice: once for the constraint that actually failed, and
 * once for the `if` wrapper ("must match \"then\" schema"), which names no rule and adds no
 * information. Drop the wrapper — unless it is all we have.
 */
function isRedundantIfWrapper(e: ErrorObject): boolean {
  return e.keyword === "if" && (e.params as { failingKeyword?: string }).failingKeyword != null;
}

function isFundingDetailsError(e: ErrorObject): boolean {
  return e.instancePath === "/fundingDetails" || e.instancePath.startsWith("/fundingDetails/");
}

/**
 * Per-shape validators, compiled lazily against the schema's own `$defs`. ajv's error spray for
 * a failed `fundingDetails` mixes every `oneOf` branch, and its schemaPaths do not reliably name
 * the branch they came from — re-validating against the tagged shape alone is what lets the
 * report carry only the errors that were meant.
 */
const branchValidators = new Map<string, ValidateFunction>();
function branchValidator(tag: string): ValidateFunction | undefined {
  const def = DEF_BY_TAG.get(tag);
  if (!def) return undefined;
  let validate = branchValidators.get(tag);
  if (!validate) {
    validate = createValidator({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: `#/$defs/${def}`,
    });
    branchValidators.set(tag, validate);
  }
  return validate;
}

/**
 * A failing `fundingDetails` makes ajv report every branch of the `oneOf`, burying the message
 * that matters. The instance's own `fundingType` tag says which shape was meant: keep only that
 * branch's errors — and when the tag itself is the problem, say exactly that in one line.
 */
function explainOneOf(errors: readonly ErrorObject[], data: unknown): string[] | undefined {
  if (!errors.some(isFundingDetailsError)) return undefined;
  if (!isRecord(data) || !isRecord(data.fundingDetails)) return undefined;

  const tag = data.fundingDetails.fundingType;
  if (typeof tag !== "string" || !FUNDING_TYPES.includes(tag)) {
    return [
      `/fundingDetails must carry a fundingType tag naming its shape (one of: ${FUNDING_TYPES.join(", ")})`,
    ];
  }

  const declared = data.fundingType;
  if (typeof declared === "string" && FUNDING_TYPES.includes(declared) && declared !== tag) {
    return [
      `fundingDetails.fundingType '${tag}' does not match the opportunity's fundingType '${declared}'`,
    ];
  }

  const validate = branchValidator(tag);
  if (!validate || validate(data.fundingDetails)) return undefined;
  return (validate.errors ?? []).map((e) => {
    const msg =
      e.keyword === "additionalProperties"
        ? `unknown field '${(e.params as { additionalProperty: string }).additionalProperty}'`
        : describe(e);
    return `/fundingDetails${e.instancePath} ${tag} details: ${msg}`;
  });
}

/** The message part of a humanized line, naming the values ajv leaves in `params`. */
function describe(e: ErrorObject): string {
  let msg = e.message ?? "is invalid";
  // ajv's "required" message already names the property; only augment where it doesn't.
  if (e.keyword === "additionalProperties") {
    const { additionalProperty } = e.params as { additionalProperty: string };
    msg += `: '${additionalProperty}'`;
  } else if (e.keyword === "enum") {
    const { allowedValues } = e.params as { allowedValues?: unknown[] };
    if (allowedValues) msg += `: ${allowedValues.join(", ")}`;
  } else if (e.keyword === "const") {
    const { allowedValue } = e.params as { allowedValue?: unknown };
    if (allowedValue !== undefined) msg += `: ${JSON.stringify(allowedValue)}`;
  }
  return msg;
}

/** Render a single ajv error as a concise, human-readable line naming the rule that failed. */
export function humanizeError(e: ErrorObject): string {
  const where = e.instancePath?.length ? e.instancePath : "(root)";
  return `${where} ${describe(e)}`;
}

/**
 * Render a list of ajv errors as human-readable lines.
 *
 * Pass the validated instance when you have it: it lets a failed `fundingDetails` be reported
 * as the one shape its tag names, instead of ajv's every-branch `oneOf` spray.
 */
export function humanizeErrors(errors: readonly ErrorObject[], data?: unknown): string[] {
  const meaningful = errors.filter((e) => !isRedundantIfWrapper(e));
  const kept = meaningful.length > 0 ? meaningful : errors;
  const detailLines = explainOneOf(kept, data);
  if (!detailLines) return kept.map(humanizeError);
  return [...detailLines, ...kept.filter((e) => !isFundingDetailsError(e)).map(humanizeError)];
}
