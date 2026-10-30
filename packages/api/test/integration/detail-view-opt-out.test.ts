/**
 * `GET /v1/opportunities/:id?count=false` serves the record and records no detail view.
 *
 * Isolation tag: `M5NOCOUNT` / `m5nocount:`.
 *
 * The frontend's leaving page reads the listing to show where a link goes, after the redirect that
 * sent the reader there has already counted their click. The opt-out exists so that one action is
 * not counted twice; what must never happen is the opt-out leaking into an ordinary read, so both
 * halves are asserted against the database the dashboard reads.
 */
import { and, count, eq, gte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, opportunityEvents } from "../../src/db/schema.js";
import { analyticsEvents } from "../../src/modules/services/insights/event-buffer.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m5nocount";
const ID = `${NS}:listing`;
/** A plausible reader. Not "curl/…" or anything the bot pattern matches. */
const READER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) M5NoCountReader/1.0" };

const run = describeWithDb;

async function detailViews(since: Date): Promise<number> {
  // Twice: a flush already in flight is joined rather than repeated.
  await analyticsEvents.flush();
  await analyticsEvents.flush();
  const [row] = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.publicId, ID));
  if (!row) throw new Error(`no row ${ID}`);
  const [counted] = await db
    .select({ value: count() })
    .from(opportunityEvents)
    .where(
      and(
        eq(opportunityEvents.opportunityId, row.id),
        eq(opportunityEvents.eventType, "detail_view"),
        gte(opportunityEvents.occurredAt, since),
      ),
    );
  return counted?.value ?? 0;
}

run("M5NOCOUNT the leaving page's read is not a detail view", () => {
  let app: FastifyInstance;
  const startedAt = new Date();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: ID,
        fundingType: "grant",
        title: "No-count fixture",
        description: "A detail-view fixture.",
        status: "open",
        operatingOrganizations: [{ name: "No-count Org", slug: NS }],
        source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M5NOCOUNT"],
        applicationUrl: "https://apply.m5nocount.example/form",
        fundingDetails: { fundingType: "grant" },
        // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture
      } as any,
      { reviewStatus: "approved", isListed: true, sourceSystem: NS },
    );
  });

  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: `${NS}:`, organizationSlugs: [NS] });
    await app.close();
    await pool.end();
  });

  const read = (query: string) =>
    app.inject({ url: `/v1/opportunities/${encodeURIComponent(ID)}${query}`, headers: READER });

  it("serves the same record with count=false, and counts nothing", async () => {
    const counted = await read("");
    const before = await detailViews(startedAt);
    const uncounted = await read("?count=false");
    expect(uncounted.statusCode, uncounted.body).toBe(200);
    expect(uncounted.json()).toEqual(counted.json());
    expect(await detailViews(startedAt)).toBe(before);
  });

  it("still counts an ordinary read, and an explicit count=true", async () => {
    const before = await detailViews(startedAt);
    expect((await read("")).statusCode).toBe(200);
    expect(await detailViews(startedAt)).toBe(before + 1);
    expect((await read("?count=true")).statusCode).toBe(200);
    expect(await detailViews(startedAt)).toBe(before + 2);
  });

  it("keeps ignoring a parameter it does not know, as it always has", async () => {
    const before = await detailViews(startedAt);
    const res = await read("?utm_source=newsletter");
    expect(res.statusCode, res.body).toBe(200);
    expect(await detailViews(startedAt)).toBe(before + 1);
  });

  it("refuses a count value that is not a boolean rather than guessing", async () => {
    expect((await read("?count=nope")).statusCode).toBe(400);
  });
});
