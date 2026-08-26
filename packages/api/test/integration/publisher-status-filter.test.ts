/**
 * Publisher status is a presentation-oriented partition over the raw editorial columns. This test
 * seeds every reachable state, including the deliberately awkward rejected+listed combination,
 * and proves the five filters cover the owned table exactly once.
 *
 * Isolation tag: `M3PSTAT` / `m3pstat:`.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities } from "../../src/db/schema.js";
import type { PublisherStatus } from "../../src/modules/services/opportunities/managed-opportunity.service.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { bearer, seedIdentity, testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3pstat";
const EMAIL = "m3pstat-publisher@rfphub.invalid";
const HANDLE = "m3pstat-publisher";
const STATUSES: PublisherStatus[] = ["merged", "rejected", "pending", "hidden", "live"];

const run = describeWithDb;

run("GET /v1/me/opportunities publisherStatus", () => {
  let app: FastifyInstance;
  let token: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      handles: [HANDLE],
      emails: [EMAIL],
    });

    const publisher = await seedIdentity(EMAIL, { handle: HANDLE });
    token = publisher.token;
    userIds.push(publisher.userId);

    const ingest = new OpportunityService();
    for (const status of STATUSES) {
      await ingest.upsertFromStandard(submission(`${NS}:${status}`, NS) as unknown as Opportunity, {
        reviewStatus: "approved",
        isListed: true,
      });
    }

    const rows = await db
      .select({ id: opportunities.id, publicId: opportunities.publicId })
      .from(opportunities)
      .where(
        inArray(
          opportunities.publicId,
          STATUSES.map((status) => `${NS}:${status}`),
        ),
      );
    const idByPublicId = new Map(rows.map((row) => [row.publicId, row.id]));
    const liveId = idByPublicId.get(`${NS}:live`);
    if (liveId === undefined) throw new Error("publisher-status survivor fixture was not inserted");

    const state = {
      merged: { reviewStatus: "rejected" as const, isListed: true, mergedIntoId: liveId },
      rejected: { reviewStatus: "rejected" as const, isListed: true, mergedIntoId: null },
      pending: { reviewStatus: "pending" as const, isListed: true, mergedIntoId: null },
      hidden: { reviewStatus: "approved" as const, isListed: false, mergedIntoId: null },
      live: { reviewStatus: "approved" as const, isListed: true, mergedIntoId: null },
    };
    for (const status of STATUSES) {
      await db
        .update(opportunities)
        .set({ ...state[status], submittedBy: publisher.account.id })
        .where(eq(opportunities.publicId, `${NS}:${status}`));
    }

    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      handles: [HANDLE],
      userIds,
      emails: [EMAIL],
    });
    await app.close();
    await pool.end();
  }, 60_000);

  const list = (query = "") =>
    app.inject({
      method: "GET",
      url: `/v1/me/opportunities${query}`,
      headers: bearer(token),
    });

  it("partitions every owned row into exactly one of the five publisher states", async () => {
    const all = await list("?limit=100");
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().total).toBe(5);

    let partitionTotal = 0;
    for (const status of STATUSES) {
      const filtered = await list(`?publisherStatus=${status}&limit=100`);
      expect(filtered.statusCode, filtered.body).toBe(200);
      const body = filtered.json();
      expect(body.total, status).toBe(1);
      expect(
        body.items.map((item: { id: string }) => item.id),
        status,
      ).toEqual([`${NS}:${status}`]);
      partitionTotal += body.total;
    }

    expect(partitionTotal, "the five filtered counts sum to the unfiltered total").toBe(
      all.json().total,
    );
  });

  it("rejects an unknown publisher status instead of ignoring it", async () => {
    const response = await list("?publisherStatus=unknown");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("bad_request");
  });
});
