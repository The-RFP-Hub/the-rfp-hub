/**
 * The prune's cross-space guard: a pair whose counterpart was embedded in ANOTHER provider's space
 * must survive a detection pass, not be deleted on the strength of a meaningless cosine.
 *
 * Isolation tag: `M3DPS` / `m3dps:`.
 *
 * THE FAILURE THIS PINS. `pruneStalePairs` recomputes each suspected pair's similarity against the
 * counterpart's stored vector. During a provider switch the counterpart's row still holds the OLD
 * space's coordinates until the backfill reaches it; a cosine between two spaces is a coordinate
 * coincidence that typically lands below any threshold. Without the model-and-provider predicate on
 * the join, the prune read that number as "no longer alike" and deleted a pair nobody had actually
 * re-measured — silently, on the first write after the switch. `search()` always had the predicate
 * (a vector from another space is not a neighbour); this suite is what keeps the prune agreeing.
 *
 * Module-load choreography (`EMBEDDING_PROVIDER` before any config-reaching import) is the same as
 * `duplicates.test.ts`, for the same reason spelled out there.
 */
process.env.EMBEDDING_PROVIDER = "deterministic";

import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALPHA_BODY, UNRELATED_BODY } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { opportunities, opportunityDuplicates, opportunityEmbeddings } = await import(
  "../../src/db/schema.js"
);
const { bearer, grantMembership, seedIdentity, seedOrganization, testAuth } = await import(
  "../helpers/auth.js"
);
const { cleanupFixtures } = await import("../helpers/cleanup.js");
const { DedupeService } = await import("../../src/modules/services/dedupe/dedupe.service.js");

const NS = "m3dps";
const EMAIL = "m3dps-publisher@rfphub.invalid";

const run = describeWithDb;

run("M3DPS prune keeps cross-space pairs", () => {
  let app: FastifyInstance;
  let token: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const publisher = await seedIdentity(EMAIL, { handle: "m3dps-publisher" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    userIds.push(publisher.userId);
    token = publisher.token;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      userIds,
      emails: [EMAIL],
    });
    await app.close();
    await pool.end();
  });

  const rowIdOf = async (publicId: string): Promise<number> => {
    const rows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no row for ${publicId}`);
    return id;
  };

  it("leaves a suspected pair alone when the counterpart's vector is from another space", async () => {
    // Two entries with UNALIKE text on purpose: if the prune wrongly compares across spaces, the
    // cosine it computes will sit far below the threshold, which is exactly the condition under
    // which the missing predicate deleted the pair. Alike text would mask the bug.
    for (const [id, title, body] of [
      [`${NS}:anchor`, "Consensus Client Grants", ALPHA_BODY],
      [`${NS}:foreign`, "Perpetuals Settlement Bounty", UNRELATED_BODY],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/opportunities",
        headers: bearer(token),
        payload: submission(id, NS, {
          title,
          description: body,
          ecosystems: ["M3DPS"],
        } as Record<string, unknown>),
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    const anchor = await rowIdOf(`${NS}:anchor`);
    const foreign = await rowIdOf(`${NS}:foreign`);
    const [low, high] = anchor < foreign ? [anchor, foreign] : [foreign, anchor];

    // A pair recorded in an earlier space, as a provider switch leaves behind.
    await db
      .insert(opportunityDuplicates)
      .values({ opportunityId: low, duplicateOfId: high, similarity: "0.9", status: "suspected" })
      .onConflictDoNothing();

    // The counterpart's row keeps its coordinates but stops belonging to the current space —
    // which is what every not-yet-backfilled row looks like the morning after a switch.
    await db
      .update(opportunityEmbeddings)
      .set({ providerId: "phantom", model: "phantom-space-v0" })
      .where(eq(opportunityEmbeddings.opportunityId, foreign));

    await new DedupeService().embedAndDetect(anchor, "all");

    const pair = await db
      .select()
      .from(opportunityDuplicates)
      .where(
        or(
          and(
            eq(opportunityDuplicates.opportunityId, low),
            eq(opportunityDuplicates.duplicateOfId, high),
          ),
          and(
            eq(opportunityDuplicates.opportunityId, high),
            eq(opportunityDuplicates.duplicateOfId, low),
          ),
        ),
      );
    expect(
      pair[0]?.status,
      "the cross-space pair was pruned — the join lost its model/provider predicate",
    ).toBe("suspected");
  });
});
