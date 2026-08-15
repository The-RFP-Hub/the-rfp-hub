/**
 * A minimal, Standard-valid opportunity for the write-path suites.
 *
 * Deliberately built by hand rather than lifted from the corpus: these tests are about what the
 * SERVER does to a submitted document — which fields it overwrites, which it refuses — so the
 * fixture has to be something a test can vary one field of at a time.
 */
import type { Opportunity } from "@the-rfp-hub/standard";

export function submission(
  id: string,
  namespace: string,
  over: Partial<Opportunity> = {},
): Record<string, unknown> {
  return {
    specVersion: "1.0.0",
    id,
    fundingType: "grant",
    title: `Fixture ${id}`,
    description: "A submission fixture.",
    status: "open",
    operatingOrganizations: [{ name: namespace, slug: namespace }],
    source: {},
    ecosystems: ["M3WRITE"],
    fundingDetails: { fundingType: "grant" },
    ...over,
  } as Record<string, unknown>;
}
