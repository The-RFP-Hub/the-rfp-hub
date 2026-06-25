import opportunitySchemaJson from "../schemas/v1.0.0/opportunity.schema.json";

/**
 * The canonical RFP Hub Standard JSON Schema (draft 2020-12) for a funding opportunity.
 * This is the single source of truth; all types in this package are generated from it.
 */
export const opportunitySchema = opportunitySchemaJson as unknown as Readonly<
  Record<string, unknown>
>;

/** The RFP Hub Standard version shipped by this package. */
export const SPEC_VERSION = "1.0.0" as const;
