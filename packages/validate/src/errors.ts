import { opportunitySchema } from "@rfp-hub/standard";
import type { ErrorObject } from "ajv";

/**
 * The type-block keys, which by the standard's own invariant are exactly the `fundingType`
 * values. Read from the schema rather than hardcoded, so a seventh type could never make this
 * message silently wrong.
 */
const TYPE_BLOCKS: readonly string[] = (() => {
  const props = (opportunitySchema as { properties?: Record<string, { enum?: unknown }> })
    .properties;
  const values = props?.fundingType?.enum;
  return Array.isArray(values) ? (values as string[]) : [];
})();

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

/**
 * `not` produces "must NOT be valid", which is true and useless. Every `not` in this schema is
 * the one-block-per-fundingType rule, so say that instead — and name the offending block when
 * the instance is available.
 */
function explainNot(e: ErrorObject, data: unknown): string | undefined {
  if (e.keyword !== "not") return undefined;
  if (!/^#\/allOf\/\d+\/then\/not$/.test(e.schemaPath)) return undefined;

  const declared = isRecord(data) && typeof data.fundingType === "string" ? data.fundingType : null;
  const extras = isRecord(data)
    ? TYPE_BLOCKS.filter((k) => k !== declared && Object.hasOwn(data, k))
    : [];

  const offending = extras.length > 0 ? `: ${extras.map((k) => `'${k}'`).join(", ")}` : "";
  const expected = declared ? ` Only the '${declared}' block may be present.` : "";
  return `carries a type block that does not match fundingType${offending}.${expected}`;
}

/** Render a single ajv error as a concise, human-readable line naming the rule that failed. */
export function humanizeError(e: ErrorObject, data?: unknown): string {
  const where = e.instancePath?.length ? e.instancePath : "(root)";

  const notMessage = explainNot(e, data);
  if (notMessage) return `${where} ${notMessage}`;

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
  return `${where} ${msg}`;
}

/**
 * Render a list of ajv errors as human-readable lines.
 *
 * Pass the validated instance when you have it: it lets the one-block-per-fundingType rule name
 * the block that should not be there, instead of ajv's bare "must NOT be valid".
 */
export function humanizeErrors(errors: readonly ErrorObject[], data?: unknown): string[] {
  const meaningful = errors.filter((e) => !isRedundantIfWrapper(e));
  const kept = meaningful.length > 0 ? meaningful : errors;
  return kept.map((e) => humanizeError(e, data));
}
