/**
 * Publisher analytics: what gets counted, what deliberately does not, and who may read the numbers.
 *
 * Isolation tag: `M3ANA` / `m3ana:`.
 *
 * THE EXCLUSIONS ARE THE INTERESTING HALF. The nightly exporter walks every entry in the corpus and
 * the compliance checker executes every published operation, both against production, every night.
 * Without the exclusion by name, every publisher's view count would be mostly us — so the test that
 * our own automation records NOTHING is as load-bearing as the test that a reader records something.
 */
import { and, eq, gte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, opportunityEvents, opportunityStatsDaily } from "../../src/db/schema.js";
import { analyticsEvents } from "../../src/modules/services/insights/event-buffer.js";
import { AnalyticsRollupService } from "../../src/modules/services/insights/rollup.service.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { describeWithDb } from "./db-gate.js";

/** The UTC day a timestamp falls in, as the rollup keys its rows. */
const utcDayOf = (at: Date) => at.toISOString().slice(0, 10);

const NS = "m3ana";
const EMAILS = {
  publisher: "m3ana-publisher@rfphub.invalid",
  stranger: "m3ana-stranger@rfphub.invalid",
};

const PUBLIC_ID = `${NS}:live`;
const PENDING_ID = `${NS}:pending`;
const BAD_LINK_ID = `${NS}:badlink`;
const APPLY_URL = "https://apply.example.org/m3ana";
const SITE_URL = "https://programme.example.org/m3ana";

/** A plausible reader. Not "curl/…" or anything the bot pattern matches — that is a later test. */
const READER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) TestReader/1.0" };

const run = describeWithDb;
const ingest = new OpportunityService();

async function seed(
  publicId: string,
  options: { reviewStatus?: "pending" | "approved"; applicationUrl?: string; website?: string },
): Promise<number> {
  await ingest.upsertFromStandard(
    {
      specVersion: "1.0.0",
      id: publicId,
      fundingType: "grant",
      title: `Analytics fixture ${publicId}`,
      description: "An analytics fixture.",
      status: "open",
      operatingOrganizations: [{ name: "Analytics Org", slug: NS }],
      source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: ["M3ANA"],
      applicationUrl: options.applicationUrl,
      website: options.website,
      fundingDetails: { fundingType: "grant" },
      // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture, not a mapper output
    } as any,
    { reviewStatus: options.reviewStatus ?? "approved", isListed: true, sourceSystem: NS },
  );
  const rows = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.publicId, publicId))
    .limit(1);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`could not seed ${publicId}`);
  return id;
}

run("M3ANA insights", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let strangerToken: string;
  let liveId: number;
  const startedAt = new Date();

  const eventsFor = async (opportunityId: number) => {
    await analyticsEvents.flush();
    return db
      .select()
      .from(opportunityEvents)
      .where(
        and(
          eq(opportunityEvents.opportunityId, opportunityId),
          gte(opportunityEvents.occurredAt, startedAt),
        ),
      );
  };

  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3ana-publisher" });
    const stranger = await seedIdentity(EMAILS.stranger, { handle: "m3ana-stranger" });
    userIds.push(publisher.userId, stranger.userId);
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    publisherToken = publisher.token;
    strangerToken = stranger.token;

    liveId = await seed(PUBLIC_ID, { applicationUrl: APPLY_URL, website: SITE_URL });
    await seed(PENDING_ID, { reviewStatus: "pending", applicationUrl: APPLY_URL });
    // A stored value is not automatically a safe one — this is the open-redirect case.
    await seed(BAD_LINK_ID, { applicationUrl: "javascript:alert(1)" });
  });

  afterAll(async () => {
    await cleanupFixtures({
      // ANCHORED AT THE SEPARATOR. `LIKE '<ns>%'` also matches a LONGER namespace that starts with
      // the same letters, so an unanchored prefix here reached into a neighbouring suite's rows and
      // hard-deleted them mid-run — taking their analytics events with it through the cascade. Ids
      // are `<namespace>:<local>`, so the colon is what makes this suite's own.
      opportunityPrefix: `${NS}:`,
      organizationSlugs: [NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  it("counts detail views and link-outs, and serves them today, before any rollup", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}`, headers: READER });
      expect(res.statusCode).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ url: `/v1/r/${PUBLIC_ID}/apply`, headers: READER });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(APPLY_URL);
    }
    const sourceClick = await app.inject({ url: `/v1/r/${PUBLIC_ID}/source`, headers: READER });
    expect(sourceClick.statusCode).toBe(302);
    expect(sourceClick.headers.location).toBe(SITE_URL);

    // A list response credits every entry it actually showed.
    const list = await app.inject({ url: "/v1/opportunities?ecosystem=M3ANA", headers: READER });
    expect(list.statusCode).toBe(200);

    await analyticsEvents.flush();

    // NO ROLLUP HAS RUN. The series unions the rollup with a live aggregate over today's raw
    // events precisely so a publisher does not see zeros all day.
    const res = await app.inject({
      url: `/v1/insights/opportunities/${PUBLIC_ID}`,
      headers: bearer(publisherToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.totals.detailViews).toBe(3);
    expect(body.totals.applyClicks).toBe(2);
    expect(body.totals.sourceClicks).toBe(1);
    expect(body.totals.listViews).toBeGreaterThanOrEqual(1);
    // Zero-filled: a day with no traffic is a zero, never a gap in the series.
    expect(body.days.length).toBe(30);
    expect(body.days[body.days.length - 1]?.detailViews).toBe(3);
  });

  it("redirects only for a publicly visible entry with a stored http(s) link", async () => {
    // A pending entry is invisible to the public reads, so its link-out must be too — otherwise the
    // redirect confirms the entry exists and hands out its URL.
    expect((await app.inject({ url: `/v1/r/${PENDING_ID}/apply` })).statusCode).toBe(404);
    // A stored `javascript:` URL behind our own domain is a phishing primitive, not a link-out.
    expect((await app.inject({ url: `/v1/r/${BAD_LINK_ID}/apply` })).statusCode).toBe(404);
    // No `website` stored at all.
    expect((await app.inject({ url: `/v1/r/${BAD_LINK_ID}/source` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/r/${NS}:nothere/apply` })).statusCode).toBe(404);
  });

  it("records nothing for our own automation, for crawlers, or for a reader who opted out", async () => {
    const before = (await eventsFor(liveId)).length;

    for (const headers of [
      { "user-agent": "rfphub-exporter/1.0.0" },
      { "user-agent": "rfphub-m2-compliance" },
      { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
      { "user-agent": "curl/8.4.0" },
      { ...READER, dnt: "1" },
      // A request that names nobody. Written as an EMPTY user-agent rather than omitting the
      // header, because `app.inject` substitutes `lightMyRequest` when one is absent — so the
      // omitted case would silently test a made-up agent instead of the missing one.
      { "user-agent": "" },
    ]) {
      const res = await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}`, headers });
      expect(res.statusCode).toBe(200);
    }

    const after = (await eventsFor(liveId)).length;
    expect(after, "six excluded requests must add nothing").toBe(before);
  });

  it("gives one session token to one address-and-agent, and another to a different agent", async () => {
    await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}`, headers: READER });
    await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}`, headers: READER });
    await app.inject({
      url: `/v1/opportunities/${PUBLIC_ID}`,
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) OtherReader/2.0" },
    });

    const rows = await eventsFor(liveId);
    const sessions = new Set(rows.map((row) => row.sessionHash));
    expect(sessions.size).toBe(2);
    // The address token is keyed differently from the session token, so the two cannot be
    // correlated by anyone holding only the stored values.
    const ips = new Set(rows.map((row) => row.ipHash));
    expect(ips.size).toBe(1);
    expect([...sessions][0]).not.toBe([...ips][0]);
    for (const hash of [...sessions, ...ips]) expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps one publisher's numbers away from everyone else", async () => {
    const stranger = await app.inject({
      url: `/v1/insights/opportunities/${PUBLIC_ID}`,
      headers: bearer(strangerToken),
    });
    expect(stranger.statusCode).toBe(403);

    const anonymous = await app.inject({ url: `/v1/insights/opportunities/${PUBLIC_ID}` });
    expect(anonymous.statusCode).toBe(401);

    const summary = await app.inject({
      url: "/v1/insights/me/summary",
      headers: bearer(publisherToken),
    });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(
      summary.json().opportunities.map((entry: { opportunityId: string }) => entry.opportunityId),
    ).toContain(PUBLIC_ID);

    const empty = await app.inject({
      url: "/v1/insights/me/summary",
      headers: bearer(strangerToken),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().opportunities).toEqual([]);
  });

  it("rolls up the days before today idempotently, and never writes a row for today", async () => {
    const rollup = new AnalyticsRollupService(db);
    const before = await app.inject({
      url: `/v1/insights/opportunities/${PUBLIC_ID}`,
      headers: bearer(publisherToken),
    });
    const todayTotals = before.json().totals;

    // The window is the two days BEFORE today, so the sweep needs a settled day to settle. These go
    // in as raw events rather than through the API, because the API can only make today's.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(opportunityEvents).values([
      { opportunityId: liveId, eventType: "detail_view" as const, occurredAt: yesterday },
      { opportunityId: liveId, eventType: "detail_view" as const, occurredAt: yesterday },
    ]);

    const first = await rollup.runBatch();
    expect(first.remaining, "a sweep is never looped to zero").toBe(0);
    const second = await rollup.runBatch();
    expect(second.processed).toBe(first.processed);

    const stored = await db
      .select()
      .from(opportunityStatsDaily)
      .where(eq(opportunityStatsDaily.opportunityId, liveId));
    expect(stored.length).toBe(1);
    expect(stored[0]?.day).toBe(utcDayOf(yesterday));
    expect(stored[0]?.detailViews).toBe(2);

    // TODAY IS NEVER ROLLED, because nothing would ever read the row: the series takes days
    // strictly before today from the rollup and live-aggregates today's raw events. Writing it
    // would be a grouped scan of the busiest, still-growing day of the table for nobody.
    expect(
      stored.some((row) => row.day === utcDayOf(new Date())),
      "the sweep must not write today",
    ).toBe(false);

    // Today's half of the series is unchanged — the rollup did not touch it — and yesterday's
    // newly settled row now shows up in the window alongside it, counted exactly once.
    const after = await app.inject({
      url: `/v1/insights/opportunities/${PUBLIC_ID}`,
      headers: bearer(publisherToken),
    });
    expect(after.json().totals).toEqual({
      ...todayTotals,
      detailViews: todayTotals.detailViews + 2,
    });
  });

  it("survives an entry deleted WHILE the sweep is running", async () => {
    // A day-wide sweep reads the events and then writes the rows, and those are two statements. An
    // opportunity deleted between them is invisible to the first and gone by the second, so the
    // foreign key rejects the batch — and a nightly job that failed this way wrote nothing for the
    // hundreds of entries that were perfectly fine. The entry that vanished has no statistics worth
    // keeping; everybody else's must still land.
    //
    // Driven with the barrier because the interleaving IS the bug: an uncommitted delete is
    // invisible to the sweep's own snapshot, and it lands while the sweep is parked on the foreign
    // key check.
    // BOTH entries are this case's own. Rolling `liveId` into a second day would change what the
    // retention case below counts, and a test that quietly reshapes its neighbour's fixture is the
    // kind of coupling this whole exercise is about.
    const doomed = await seed(`${NS}:doomed`, {});
    const survivor = await seed(`${NS}:survivor`, {});
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const opportunityId of [doomed, survivor]) {
      await db
        .insert(opportunityEvents)
        .values({ opportunityId, eventType: "detail_view", occurredAt: yesterday });
    }

    const barrier = await openLockBarrier();
    let outcome: { processed: number };
    try {
      await barrier.run("delete from opportunities where id = $1", [doomed]);
      const sweeping = new AnalyticsRollupService(db).runBatch({ days: 2 });
      await barrier.waitForWaiters(1);
      await barrier.commit();
      outcome = await sweeping;
    } finally {
      await barrier.rollback();
    }

    // Completed rather than thrown, and the surviving entry got its row.
    expect(outcome.processed).toBeGreaterThan(0);
    const survivorRow = await db
      .select()
      .from(opportunityStatsDaily)
      .where(
        and(
          eq(opportunityStatsDaily.opportunityId, survivor),
          eq(opportunityStatsDaily.day, utcDayOf(yesterday)),
        ),
      );
    expect(survivorRow.length, "the entries that still exist are still rolled up").toBe(1);
  });

  it("prunes raw events past the retention window in the same invocation as the rollup", async () => {
    const rollup = new AnalyticsRollupService(db);
    // A cutoff far in the future makes every event "old", which is the branch under test; the
    // retention days themselves are a config reader with its own unit test.
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 5);

    // ONE INVOCATION, BOTH HALVES. `retention` used to be a second scheduled job, which made
    // "roll up before you delete" the scheduler's to remember and nothing's to enforce; a prune
    // that ran on a night the rollup failed would delete events whose totals were never recorded.
    const swept = await rollup.runBatch({ now: future });
    expect(swept.remaining).toBe(0);
    expect(swept.details.pruned, "the sweep prunes as its last step").toBeGreaterThan(0);

    // Idempotent: a second run finds nothing left to delete and says so.
    const again = await rollup.runBatch({ now: future });
    expect(again.details.pruned).toBe(0);

    const remainingRollup = await db
      .select()
      .from(opportunityStatsDaily)
      .where(eq(opportunityStatsDaily.opportunityId, liveId));
    expect(remainingRollup.length, "the daily rows are the long-term record").toBe(1);
  });
});
