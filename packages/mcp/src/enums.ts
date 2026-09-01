/**
 * The filter vocabularies, DERIVED from the published standard at module load.
 *
 * A hard-coded copy could offer a filter the API rejects, or silently stop offering one it gained,
 * and the failure would look like a broken tool rather than a stale list. If a property ever loses
 * its enum this throws at boot rather than shipping an unconstrained filter.
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

/** The API's LIST CONTRACT, not the standard: these name columns no document field declares. */
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
