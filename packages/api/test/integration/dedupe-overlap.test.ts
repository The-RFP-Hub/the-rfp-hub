/**
 * The overlap arm against a real database: detection, pruning, the pending predicate, and rollback.
 *
 * Isolation tag: `M3OVL` / `m3ovl:`.
 *
 * The unit tests prove the RULE. This file proves the three things only a database can show, and
 * they are exactly the three migration traps a reviewer should look at first:
 *
 *   1. `ensureEmbedding`'s short-circuit. Every pre-existing row matches its content hash with a
 *      NULL norm, so a hash-only short-circuit returns early, never writes the scalars, and leaves
 *      the row in the backfill's predicate for ever — a cursor that cannot retire.
 *   2. `shouldPrune`'s null handling. An overlap-arm pair has a cosine below the lexical threshold
 *      BY CONSTRUCTION, so a cosine-only cleanup deletes it on the first nightly pass.
 *   3. `upsert`'s `onConflictDoUpdate` set. The rows the backfill exists to repair already exist,
 *      so every one of them takes the conflict branch.
 *
 * `EMBEDDING_PROVIDER` is set before any import for the reason `duplicates.test.ts` explains at
 * length: `config.ts` reads the environment once, at module load.
 */
process.env.EMBEDDING_PROVIDER = "lexical";

import { and, eq, isNull, or } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../src/modules/services/dedupe/embedding-provider.js";
import { describeWithDb } from "./db-gate.js";

const { db, pool } = await import("../../src/db/client.js");
const { opportunities, opportunityDuplicates, opportunityEmbeddings } = await import(
  "../../src/db/schema.js"
);
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");
const { LexicalEmbeddingProvider } = await import(
  "../../src/modules/services/dedupe/embedding-provider.js"
);
const { RULES_VERSION } = await import("../../src/modules/services/dedupe/duplicate-signal.js");
const { OpportunityMetaService } = await import(
  "../../src/modules/services/opportunities/opportunity-meta.service.js"
);
const { config } = await import("../../src/config.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");

const NS = "m3ovl";

/**
 * SUITE-LOCAL BODIES, not the shared `dedupe-text.ts` ones, and this is isolation rather than
 * duplication.
 *
 * The integration suites share one database and run concurrently. A candidate list is capped at
 * `DEDUPE_MAX_MATCHES` and ordered by distance, so fixtures that share a subject with another
 * suite's fixtures crowd that suite's intended counterpart out of its own top five — and the
 * failure lands over there, on a test that has nothing to do with this one. A distinct subject is
 * what keeps each suite's nearest neighbour its own partner. (`duplicates.test.ts` makes the same
 * point about its per-test labels.)
 *
 * Long on purpose: the featurizer is a bag of words, and two short records are separated mostly by
 * noise.
 */
const SUBJECT_BODY =
  "The Antarctic Ice Core Custody Fellowship funds the physical transport, cold-chain storage and " +
  "long-term curation of drilled ice cores held by university glaciology departments. Fellows " +
  "audit an existing core archive, document its provenance and freezer history, and publish a " +
  "machine-readable manifest of every stored section with its depth interval and drilling season. " +
  "Awards cover freezer maintenance contracts, calibrated logging hardware and the technician time " +
  "needed to re-inventory a collection that has outlived its original grant. Applicants must show " +
  "that the archive is at genuine risk of loss through equipment failure or institutional " +
  "reorganisation, and must commit to depositing the manifest under an open licence. Reviews run " +
  "twice a year and are decided by working glaciologists rather than by programme staff. Fellows " +
  "meet once during the term to compare curation practice across the participating archives.";

const OTHER_BODY =
  "This residency places textile conservators inside regional costume museums for eight months to " +
  "stabilise garments that are too fragile to display. Residents survey the holdings, prioritise " +
  "items by material and by rate of deterioration, and carry out wet cleaning, support stitching " +
  "and mount-making under a supervising conservator. The programme pays a stipend, materials and " +
  "the cost of a purpose-built storage mount for every treated garment. Applicants supply a " +
  "portfolio of previous treatments with before-and-after documentation and a written condition " +
  "assessment of one object of their choosing. Museums hosting a resident must guarantee bench " +
  "space, climate control and access to their accession records. Placements are announced each " +
  "spring, and every treatment is written up in a public report at the end of the residency.";

/**
 * The re-listing this arm exists for: the leading 40 % of a body, verbatim.
 *
 * Deliberately NOT a paraphrase. The lexical arm already catches those; this is the shape it
 * cannot, because normalisation erases exactly the difference — length — that distinguishes a
 * truncated copy from an unrelated entry.
 */
const truncate = (text: string, fraction: number): string => {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, Math.max(1, Math.floor(words.length * fraction))).join(" ");
};

const insertOpportunity = async (suffix: string, body: string): Promise<number> => {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: `${NS}:${suffix}`,
      fundingType: "grant",
      status: "open",
      title: `M3OVL ${suffix}`,
      description: body,
      applicationUrl: "https://example.invalid/m3ovl/apply",
      operatingOrganizations: [{ name: "M3OVL fixture", slug: NS }],
      ecosystems: ["M3OVL"],
      reviewStatus: "approved",
      isListed: true,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`failed to insert ${suffix}`);
  return id;
};

const pairBetween = async (left: number, right: number) => {
  const rows = await db
    .select()
    .from(opportunityDuplicates)
    .where(
      or(
        and(
          eq(opportunityDuplicates.opportunityId, left),
          eq(opportunityDuplicates.duplicateOfId, right),
        ),
        and(
          eq(opportunityDuplicates.opportunityId, right),
          eq(opportunityDuplicates.duplicateOfId, left),
        ),
      ),
    )
    .limit(1);
  return rows[0];
};

describeWithDb("M3OVL the overlap arm", () => {
  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS });
    await pool.end();
  });

  /**
   * The headline. Both sides are embedded, the pair is recorded, and the numbers on the row say
   * plainly which arm decided — a cosine BELOW the lexical threshold beside `arm: "overlap"`.
   */
  it("detects a truncated re-listing that the lexical arm alone would miss", async () => {
    const full = await insertOpportunity("full", SUBJECT_BODY);
    const short = await insertOpportunity("truncated", truncate(SUBJECT_BODY, 0.4));

    const service = new DedupeService();
    await service.embedAndDetect(full, "all");
    const matches = await service.embedAndDetect(short, "all");

    const match = matches.find((m) => m.id === `${NS}:full`);
    expect(match, `matches: ${JSON.stringify(matches)}`).toBeDefined();
    expect(match?.similarity ?? 1).toBeLessThan(config.dedupe.similarityThreshold);
    expect(match?.matchedOn).toContain("overlap");
    // Structural corroboration is REPORTED — both fixtures share a URL and an org — and it is not
    // what decided anything. The label array carries labels, never the values themselves.
    expect(match?.matchedOn).toContain("application_url");
    expect(match?.matchedOn).toContain("operating_org");
    expect(JSON.stringify(match?.matchedOn)).not.toContain("example.invalid");

    const pair = await pairBetween(full, short);
    expect(pair?.status).toBe("suspected");
    expect(pair?.rulesVersion).toBe(RULES_VERSION);
    const signal = pair?.signal as { arm: string; overlap: number; minTokens: number };
    expect(signal.arm).toBe("overlap");
    expect(signal.overlap).toBeGreaterThanOrEqual(config.dedupe.overlapThreshold);
    expect(signal.minTokens).toBeGreaterThanOrEqual(config.dedupe.overlapMinTokens);
    // `similarity` keeps its old meaning exactly: the lexical cosine, nothing else.
    expect(Number(pair?.similarity)).toBeCloseTo(match?.similarity ?? 0, 3);
  });

  /**
   * TRAP 2. The pair recorded above has a cosine under the lexical threshold, so a prune pass that
   * asked only "is the cosine still above 0.75" would delete it — and the next detection pass would
   * put it straight back, re-notifying both owners each time round.
   */
  it("does not prune the overlap-arm pair it just wrote", async () => {
    const full = await insertOpportunity("survive-full", SUBJECT_BODY);
    const short = await insertOpportunity("survive-short", truncate(SUBJECT_BODY, 0.4));

    const service = new DedupeService();
    await service.embedAndDetect(full, "all");
    await service.embedAndDetect(short, "all");
    expect(await pairBetween(full, short)).toBeDefined();

    // A second pass is exactly what the nightly backfill does.
    await service.embedAndDetect(short, "all");
    await service.embedAndDetect(full, "all");
    expect(await pairBetween(full, short), "the overlap pair survived a prune pass").toBeDefined();
  });

  /**
   * The other half of trap 2: a counterpart whose scalars are unknown is LEFT ALONE, not deleted.
   * This is the state the whole table is in for the first backfill run after deploy, and the state
   * `!decidePair(...)` would have emptied the queue in.
   */
  it("leaves a pair alone when the counterpart's norm is still NULL", async () => {
    const full = await insertOpportunity("null-norm-full", SUBJECT_BODY);
    const short = await insertOpportunity("null-norm-short", truncate(SUBJECT_BODY, 0.4));

    const service = new DedupeService();
    await service.embedAndDetect(full, "all");
    await service.embedAndDetect(short, "all");
    expect(await pairBetween(full, short)).toBeDefined();

    // Exactly the post-migration shape: a valid vector, a matching content hash, unknown scalars.
    await db
      .update(opportunityEmbeddings)
      .set({ norm: null, tokenCount: null })
      .where(eq(opportunityEmbeddings.opportunityId, full));

    await service.embedAndDetect(short, "all");
    expect(
      await pairBetween(full, short),
      "an unmeasurable counterpart is not the same fact as a dissimilar one",
    ).toBeDefined();
  });

  /**
   * TRAPS 1 AND 3 TOGETHER. A row with a current vector and NULL scalars is pending, and ONE
   * backfill pass retires it — which only happens if the short-circuit lets it through AND the
   * upsert's conflict branch writes the scalars.
   */
  it("selects a row with a current vector but no norm, and retires it in one pass", async () => {
    const id = await insertOpportunity("backfill", OTHER_BODY);
    const service = new DedupeService();
    await service.embedAndDetect(id, "all");

    await db
      .update(opportunityEmbeddings)
      .set({ norm: null, tokenCount: null })
      .where(eq(opportunityEmbeddings.opportunityId, id));

    expect(await service.pendingEmbeddingIds(500)).toContain(id);
    // What `runBatch` does per selected row, driven for THIS row only: the whole-table form would
    // embed and re-detect every other concurrently-running suite's fixtures as a side effect.
    await service.embedAndDetect(id, "all");
    expect(
      await service.pendingEmbeddingIds(500),
      "a cursor job that cannot retire its own rows is the failure docs/jobs.md forbids",
    ).not.toContain(id);

    const stored = await db
      .select()
      .from(opportunityEmbeddings)
      .where(eq(opportunityEmbeddings.opportunityId, id));
    expect(stored[0]?.norm).toBeGreaterThan(0);
    expect(stored[0]?.tokenCount).toBeGreaterThan(0);
  });

  /**
   * The capability gate. A provider that cannot supply a norm must never select rows it could never
   * fix — otherwise it selects the whole table on every run, for ever.
   */
  it("does not select missing scalars for a provider that supplies no norm", async () => {
    const id = await insertOpportunity("no-norm-provider", OTHER_BODY);
    const real = new LexicalEmbeddingProvider();
    await new DedupeService().embedAndDetect(id, "all");
    await db
      .update(opportunityEmbeddings)
      .set({ norm: null, tokenCount: null })
      .where(eq(opportunityEmbeddings.opportunityId, id));

    const normless: EmbeddingProvider = {
      id: real.id,
      model: real.model,
      dimensions: real.dimensions,
      suppliesNorm: false,
      embed: (text) => real.embed(text),
      embedDetailed: async (text) => ({ vector: await real.embed(text), norm: null, tokens: null }),
    };
    const pending = await new DedupeService(db, { provider: normless }).pendingEmbeddingIds(500);
    expect(pending).not.toContain(id);
  });

  /**
   * THE ROLLBACK, tested rather than asserted. With the arm switched off, the pairs it wrote carry
   * a rule version the current rule does not recognise, and the backfill's resweep arm retires them
   * — which is the whole reason `rules_version` exists. Without it, flipping the switch leaves the
   * rows in the queue indefinitely, because pruning only runs for entries the backfill selects and
   * a drained backfill selects nothing.
   */
  it("retires overlap-arm pairs when the arm is switched off", async () => {
    const full = await insertOpportunity("rollback-full", SUBJECT_BODY);
    const short = await insertOpportunity("rollback-short", truncate(SUBJECT_BODY, 0.4));

    await new DedupeService().embedAndDetect(full, "all");
    await new DedupeService().embedAndDetect(short, "all");
    const pair = await pairBetween(full, short);
    expect(pair).toBeDefined();

    // A deployment that has turned the arm off. Same rows, same vectors, a different rule — and the
    // rule version on the row no longer matches, which is what the resweep arm selects on.
    const off = new DedupeService(db, {
      config: {
        ...config,
        dedupe: { ...config.dedupe, overlapEnabled: false },
      },
    });
    await db
      .update(opportunityDuplicates)
      .set({ rulesVersion: RULES_VERSION - 1 })
      .where(eq(opportunityDuplicates.id, pair?.id ?? -1));

    // The resweep arm directly, rather than through `runBatch`: inside `runBatch` it is gated on
    // the embedding cursor being drained, and in a shared test database that cursor is whatever
    // every other concurrent suite happens to have left pending.
    const swept = await off.resweepStaleRules(200);
    expect(swept).toBeGreaterThan(0);
    expect(
      await pairBetween(full, short),
      "the rollback retired the orphaned pair",
    ).toBeUndefined();
  });

  /**
   * A pair written before `signal` existed must render as "no reasons recorded" — an EMPTY ARRAY.
   * Not an absent field, not a crash, and deliberately not structural labels invented from today's
   * rows: a legacy row's decision inputs are genuinely unknown.
   */
  it("maps a legacy pair with a NULL signal to an empty matchedOn", async () => {
    const left = await insertOpportunity("legacy-left", SUBJECT_BODY);
    const right = await insertOpportunity("legacy-right", OTHER_BODY);
    await db.insert(opportunityDuplicates).values({
      opportunityId: Math.min(left, right),
      duplicateOfId: Math.max(left, right),
      similarity: "0.812",
      status: "suspected",
    });

    const stored = await db
      .select()
      .from(opportunityDuplicates)
      .where(
        and(
          eq(opportunityDuplicates.opportunityId, Math.min(left, right)),
          isNull(opportunityDuplicates.signal),
        ),
      )
      .limit(1);
    expect(stored[0]?.signal ?? null).toBeNull();

    const row = (
      await db.select().from(opportunities).where(eq(opportunities.id, left)).limit(1)
    )[0];
    if (!row) throw new Error("fixture row vanished");
    const matches = await new OpportunityMetaService(db).duplicates({
      row,
      privileged: true,
      principal: null,
    });
    const legacy = matches.find((match) => match.id === `${NS}:legacy-right`);
    expect(legacy?.matchedOn).toEqual([]);
  });
});
