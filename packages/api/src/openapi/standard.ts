/**
 * DERIVATION LAYER — the served OpenAPI components read whatever the RFP Hub Standard already
 * defines straight out of the Standard's canonical JSON Schema, at module load, instead of
 * re-typing it in `schemas.ts`. Enums, formats, nullability and the top-level `required` list can
 * therefore never drift from `@the-rfp-hub/standard`: a spec change either flows through
 * automatically or fails fast here at boot.
 *
 * What is deliberately NOT derived:
 * - constraint keywords that belong to INPUT validation (`const`, `pattern`, `min/maxLength`,
 *   `uniqueItems`): a response component describes the shape the API emits, and re-publishing
 *   ingest-time constraints would turn a stricter Standard into a serialization failure;
 * - `$defs` (organization, provenance, deadline, funding, …): they are not registered as OpenAPI
 *   components, and the serializer must pass those sub-objects through untouched, so every `$ref`
 *   is served as a permissive object — and a `oneOf` over such refs (`fundingDetails`, the tagged
 *   union of the six detail shapes) collapses to the same permissive object;
 * - delivery concerns the Standard cannot know (list vs detail) — `schemas.ts` annotates those.
 */
import { opportunitySchema } from "@the-rfp-hub/standard";

/** An open JSON-Schema fragment. The Standard is data here, not a type. */
export type JsonSchema = Record<string, unknown>;

const standard = opportunitySchema as JsonSchema;
const standardProperties = standard.properties as Record<string, JsonSchema>;

/**
 * The Standard's own top-level `required` list, in its own order. The served components declare
 * exactly this — the API never requires more, and never quietly requires less.
 */
export const STANDARD_REQUIRED: readonly string[] = Object.freeze([
  ...(standard.required as string[]),
]);

/**
 * The `enum` a Standard property declares. Throws at boot if that property ever loses its enum.
 * Used by the REQUEST contract (routes/opportunities/types.ts) so the values the list endpoint
 * accepts as filters cannot drift from the values the response components publish.
 */
export function standardEnum(name: string): string[] {
  const values = standardProperties[name]?.enum;
  if (!Array.isArray(values)) {
    throw new Error(`the Standard's '${name}' property declares no enum`);
  }
  return [...values] as string[];
}

/** A `$ref` into the Standard's `$defs`, served as a pass-through object (see the file header). */
const PASSTHROUGH_OBJECT = { type: "object", additionalProperties: true } as const;

/** Structural shape of a Standard subschema: type/format/items/additionalProperties only. */
function shapeOf(subschema: JsonSchema): JsonSchema {
  if (typeof subschema.$ref === "string") return { ...PASSTHROUGH_OBJECT };
  // A tagged union whose branches are all `$defs` refs (fundingDetails) is a union of
  // pass-through objects, i.e. a pass-through object.
  if (Array.isArray(subschema.oneOf)) return { ...PASSTHROUGH_OBJECT };
  if (subschema.type === "array") {
    const items = shapeOf((subschema.items ?? {}) as JsonSchema);
    return typeof subschema.minItems === "number"
      ? { type: "array", minItems: subschema.minItems, items }
      : { type: "array", items };
  }
  if (subschema.type === "object") {
    return { type: "object", additionalProperties: subschema.additionalProperties ?? true };
  }
  const shape: JsonSchema = { type: subschema.type };
  if (typeof subschema.format === "string") shape.format = subschema.format;
  return shape;
}

/**
 * A served component property, derived from the Standard's top-level property of the same name.
 * `overrides` win — that is where the API adds what the Standard cannot know.
 */
export function standardProperty(name: string, overrides: JsonSchema = {}): JsonSchema {
  const source = standardProperties[name];
  if (!source) throw new Error(`the Standard has no top-level '${name}' property`);
  const property = shapeOf(source);
  if (Array.isArray(source.enum)) property.enum = [...source.enum];
  if (typeof source.description === "string") property.description = source.description;
  return { ...property, ...overrides };
}

/**
 * Mark a property as served on the detail object only — the one thing the Standard genuinely
 * cannot express, since "list vs detail" is a delivery decision (FIELDS.md "Delivery").
 */
export function detailOnly(property: JsonSchema): JsonSchema {
  const note = "Served on the detail object only; the list projection omits it.";
  const description = property.description ? `${property.description} ${note}` : note;
  return { ...property, description };
}
