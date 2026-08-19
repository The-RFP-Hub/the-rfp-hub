/**
 * THE SHUTDOWN FLUSH DRAINS AGAINST A LIVE POOL — proved, not asserted by inspection.
 *
 * Isolation tag: `M3ANA` / `m3shut:`.
 *
 * Fastify runs `onClose` hooks LIFO, so registration order is the INVERSE of execution order. When
 * the pool-closing hook was added in `server.ts` after `buildApp` returned, it was registered last
 * and therefore ran FIRST, and every buffered event on shutdown was written into a pool that had
 * already ended. Nothing about that fails loudly: the buffer swallows its own write errors, because
 * a metric must never take down a request.
 *
 * So the ordering is now a decision made in one place — `buildApp({ closePool: true })` registers
 * the pool hook first and the flush hook second — and this file is what holds it. It is a SEPARATE
 * file because it has to close the shared pool, which every other suite in the run still needs;
 * Vitest gives each test file its own module registry, so the pool this closes is its own.
 *
 * The proof deliberately does not use that pool afterwards: a fresh `pg.Client` reads the row back,
 * so "the event landed" cannot be an artefact of the very connection under test.
 */
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities } from "../../src/db/schema.js";
import { analyticsEvents } from "../../src/modules/services/insights/event-buffer.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { describeWithDb } from "./db-gate.js";

// NOT `m3shut`: `insights.test.ts` sweeps `m3ana%`, which matched every id here and deleted them
// — with their analytics events — while this suite was asserting on them. No namespace may be a
// prefix of another; see helpers/cleanup.ts.
const NS = "m3shut";
const PUBLIC_ID = `${NS}:one`;
const READER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) TestReader/1.0" };

const run = describeWithDb;

run("M3ANA shutdown flush", () => {
  afterAll(async () => {
    // The app closed its own pool, so cleanup opens a fresh client of its own.
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    await client.query(
      "delete from opportunity_events where opportunity_id in (select id from opportunities where public_id like $1)",
      [`${NS}:%`],
    );
    await client.query("delete from opportunities where public_id like $1", [`${NS}:%`]);
    await client.query("delete from organizations where slug = $1", [NS]);
    await client.end();
  });

  it("writes the buffered events during app.close(), before the pool is ended", async () => {
    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: PUBLIC_ID,
        fundingType: "grant",
        title: "Shutdown fixture",
        description: "A shutdown fixture.",
        status: "open",
        operatingOrganizations: [{ name: "Shutdown Org", slug: NS }],
        source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3ANASHUT"],
        fundingDetails: { fundingType: "grant" },
        // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture
      } as any,
      { reviewStatus: "approved", isListed: true, sourceSystem: NS },
    );
    const rows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.publicId, PUBLIC_ID))
      .limit(1);
    const opportunityId = rows[0]?.id;
    expect(opportunityId).toBeTruthy();

    const app = await buildApp({ closePool: true });
    await app.ready();

    // MEASURED AS A DELTA, not as an absolute. `analyticsEvents` is a module-level singleton shared
    // by every app in this worker PROCESS, and vitest runs test files in the same process — so any
    // other suite making a public detail read is also in that buffer. Asserting its total depth
    // made this file fail for what its neighbours did, which is the opposite of what it is about.
    const before = analyticsEvents.depth;

    // Fewer than the flush size and well inside the flush interval, so nothing has been written yet
    // — the shutdown hook is the only thing that can save these.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}`, headers: READER });
      expect(res.statusCode).toBe(200);
    }
    expect(analyticsEvents.depth - before, "still buffered, not yet written").toBe(3);

    await app.close();
    // The flush empties the buffer for everyone, which is a fact about the shutdown hook and is
    // safe to assert absolutely: whatever else was in there, it was written too.
    expect(analyticsEvents.depth).toBe(0);

    // A connection this app never had, so the answer cannot come from the pool under test.
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    const counted = await client.query<{ n: string }>(
      "select count(*)::int as n from opportunity_events where opportunity_id = $1",
      [opportunityId],
    );
    await client.end();
    expect(Number(counted.rows[0]?.n)).toBe(3);

    // …and the pool really was closed by the same shutdown, which is what makes the ordering matter.
    await expect(pool.query("select 1")).rejects.toThrow();
  });
});
