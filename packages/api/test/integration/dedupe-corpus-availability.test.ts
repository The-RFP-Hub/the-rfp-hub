/**
 * The provider-switch tripwire on the submit-time duplicate check.
 *
 * Isolation tag: `M3DCA` / `m3dca:`. The fake provider has a suite-specific model and id as well, so
 * another integration file writing embeddings into the shared gate database cannot accidentally
 * make this corpus look compatible.
 */
import { eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../src/modules/services/dedupe/embedding-provider.js";
import { describeWithDb } from "./db-gate.js";

const { db, pool } = await import("../../src/db/client.js");
const { opportunities, opportunityEmbeddings } = await import("../../src/db/schema.js");
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");

const NS = "m3dca";
const vector = [1, ...Array<number>(1535).fill(0)];

const provider: EmbeddingProvider = {
  id: "m3dca-live-provider",
  model: "m3dca-live-model-v2",
  dimensions: 1536,
  embed: vi.fn(async () => vector),
};

const insertOpportunity = async (suffix: string): Promise<number> => {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: `${NS}:${suffix}`,
      fundingType: "grant",
      status: "open",
      title: `M3DCA ${suffix}`,
      description: "A corpus-availability integration fixture.",
      operatingOrganizations: [{ name: "M3DCA", slug: NS }],
      reviewStatus: "approved",
      isListed: true,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`failed to insert ${suffix}`);
  return id;
};

describeWithDb("M3DCA duplicate-check corpus availability", () => {
  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS });
    await pool.end();
  });

  it("reports unavailable, and warns once, when every stored corpus vector is from another model", async () => {
    const corpusId = await insertOpportunity("old-corpus");
    const submittedId = await insertOpportunity("new-submission");
    await db.insert(opportunityEmbeddings).values({
      opportunityId: corpusId,
      providerId: "m3dca-retired-provider",
      model: "m3dca-retired-model-v1",
      embedding: vector,
      contentHash: "retired-space-fixture",
    });

    const logger = { warn: vi.fn() };
    const service = new DedupeService(db, { provider, logger });

    await expect(service.check(submittedId, "public")).resolves.toEqual({
      status: "unavailable",
      duplicates: [],
    });
    await expect(service.check(submittedId, "public")).resolves.toEqual({
      status: "unavailable",
      duplicates: [],
    });

    expect(provider.embed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: provider.id,
        model: provider.model,
        compatibleEmbeddingCount: 0,
        remedy: "run the embedding-backfill job",
      }),
      expect.stringContaining("run the embedding-backfill job"),
    );

    const stored = await db
      .select()
      .from(opportunityEmbeddings)
      .where(eq(opportunityEmbeddings.opportunityId, submittedId));
    expect(stored, "the unavailable submit-time check leaves the row for backfill").toEqual([]);
  });
});
