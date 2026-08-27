/**
 * The filter vocabularies, DERIVED from the published standard at module load.
 *
 * Hard-coding `["grant", "hackathon", ...]` here would mean this server could offer a filter the
 * API rejects with a 400, or silently stop offering one the API gained — and the failure would
 * look to the caller like a broken tool rather than a stale copy. The standard's schema is the one
 * authority; if a property ever loses its enum, this throws at boot instead of shipping an
 * unconstrained filter.
 */
import { opportunitySchema } from "@the-rfp-hub/standard";

type JsonSchemaLike = { properties?: Record<string, { enum?: unknown }> };

function standardEnum(name: string): readonly string[] {
  const values = (opportunitySchema as JsonSchemaLike).properties?.[name]?.enum;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`the RFP Hub Standard's '${name}' property declares no enum`);
  }
  return Object.freeze(values.map(String));
}

/** `grant`, `hackathon`, … — whatever the standard currently declares. */
export const FUNDING_TYPES = standardEnum("fundingType");

/** `upcoming`, `open`, `closed`, … — whatever the standard currently declares. */
export const STATUSES = standardEnum("status");

/**
 * Sort keys, which belong to the API's LIST CONTRACT rather than to the standard — they name
 * derived and bookkeeping columns (`nextDeadlineAt`, `createdAt`) that no document field declares,
 * so there is nothing in the schema to derive them from. A contract test asserts this set against
 * the API's own published query schema.
 */
export const SORT_FIELDS = Object.freeze([
  "nextDeadlineAt",
  "opensAt",
  "postedAt",
  "updatedAt",
  "createdAt",
] as const);

export const SORT_ORDERS = Object.freeze(["asc", "desc"] as const);

/** Zod's `enum()` wants a non-empty tuple; the derived arrays are proven non-empty above. */
export function asEnumValues(values: readonly string[]): [string, ...string[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("empty enum");
  return [first, ...rest];
}
