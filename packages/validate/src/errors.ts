import type { ErrorObject } from "ajv";

/** Render a single ajv error as a concise, human-readable line. */
export function humanizeError(e: ErrorObject): string {
  const where = e.instancePath?.length ? e.instancePath : "(root)";
  let msg = e.message ?? "is invalid";
  // ajv's "required" message already names the property; only augment where it doesn't.
  if (e.keyword === "additionalProperties") {
    const { additionalProperty } = e.params as { additionalProperty: string };
    msg += `: '${additionalProperty}'`;
  } else if (e.keyword === "enum") {
    const { allowedValues } = e.params as { allowedValues?: unknown[] };
    if (allowedValues) msg += `: ${allowedValues.join(", ")}`;
  }
  return `${where} ${msg}`;
}

/** Render a list of ajv errors as human-readable lines. */
export function humanizeErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map(humanizeError);
}
