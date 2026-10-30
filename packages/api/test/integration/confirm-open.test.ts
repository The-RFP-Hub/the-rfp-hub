/**
 * A reviewer's "confirm still open", and the "closing soon" list it is used from.
 *
 * Isolation tag: `M5OPEN` / `m5open:`.
 *
 * Two properties carry the weight here:
 *
 *   1. THE CONFIRMATION MOVES `last_seen_at` AND NOTHING ELSE. `updated_at` re-queues a source
 *      check and is the public "updated" date; the reviewer pins decide whether a link-out goes
 *      straight through. A hand check vouches for neither, so the test compares the whole row.
 *   2. THE LIST IS THE JOB'S RULE. Every entry it shows is checked against the staleness job's own
 *      decision at the date the list names, and the two cases the job never closes for inactivity —
 *      a future fixed deadline, and a past-due entry — are seeded to prove they are left out.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { type OpportunityRow, auditLog, opportunities } from "../../src/db/schema.js";
import { StalenessService } from "../../src/modules/services/jobs/staleness.service.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  CONFIRM_OPEN_DEFAULT_REASON,
  ReviewService,
} from "../../src/modules/services/review/review.service.js";
import { nextDeadlineAt } from "../../src/modules/shared/deadlines.js";
import { inactiveBeforeOf } from "../../src/modules/shared/staleness.js";
import { bearer, seedIdentity, seedOrganization, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m5open";
const EMAILS = {
  submitter: "m5open-submitter@rfphub.invalid",
  reviewer: "m5open-reviewer@rfphub.invalid",
};
const DAY = 86_400_000;
const INACTIVE_DAYS = 90;

const run = describeWithDb;
const ingest = new OpportunityService();

type Deadline = { deadlineType: "fixed" | "rolling"; date?: string; label?: string };

async function seed(
  publicId: string,
  options: {
    reviewStatus?: "pending" | "approved";
    isListed?: boolean;
    status?: "open" | "closed";
    deadlines?: Deadline[];
    /** Days before now the inactivity clock reads. */
    quietDays: number;
  },
): Promise<OpportunityRow> {
  await ingest.upsertFromStandard(
    {
      specVersion: "1.0.0",
      id: publicId,
      fundingType: "grant",
      title: `Confirm-open fixture ${publicId}`,
      description: "A confirm-open fixture.",
      status: options.status ?? "open",
      operatingOrganizations: [{ name: "Confirm-open Org", slug: NS }],
      source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: ["M5OPEN"],
      applicationUrl: `https://apply.m5open.example/${encodeURIComponent(publicId)}`,
      website: "https://m5open.example/",
      deadlines: options.deadlines ?? [{ deadlineType: "rolling" }],
      fundingDetails: { fundingType: "grant" },
      // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture, not a mapper output
    } as any,
    {
      reviewStatus: options.reviewStatus ?? "approved",
      isListed: options.isListed ?? true,
      sourceSystem: NS,
    },
  );
  const quietSince = new Date(Date.now() - options.quietDays * DAY);
  // Both halves of the clock set explicitly, so `coalesce(last_seen_at, updated_at)` is known.
  await db
    .update(opportunities)
    .set({
      lastSeenAt: quietSince,
      updatedAt: new Date(quietSince.getTime() - 10 * DAY),
      reviewedApplicationUrl: `https://apply.m5open.example/${encodeURIComponent(publicId)}`,
      reviewedWebsite: "https://m5open.example/",
    })
    .where(eq(opportunities.publicId, publicId));
  return rowOf(publicId);
}

async function rowOf(publicId: string): Promise<OpportunityRow> {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.publicId, publicId));
  if (!row) throw new Error(`no row ${publicId}`);
  return row;
}

/** Audit rows a PERSON wrote as an `update` — the seed's own import row is the job's, not this. */
async function auditRows(id: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectKind, "opportunity"),
        eq(auditLog.subjectId, id),
        eq(auditLog.action, "update"),
        eq(auditLog.actorKind, "user"),
      ),
    )
    .orderBy(desc(auditLog.id));
}

const fixed = (at: Date): Deadline => ({
  deadlineType: "fixed",
  date: at.toISOString(),
  label: "application",
});

/** The job's private decision, driven directly: the property is the rule, not the page walk. */
const job = new StalenessService(db) as unknown as {
  closureReason(row: OpportunityRow, next: Date | null, now: Date, before: Date): string | null;
};
const jobDecides = (row: OpportunityRow, at: Date) =>
  job.closureReason(
    row,
    nextDeadlineAt(row.deadlines, at),
    at,
    inactiveBeforeOf(at, INACTIVE_DAYS),
  );

interface ClosingSoonBody {
  items: {
    id: string;
    closesAt: string;
    closesBy: "inactivity" | "final_deadline";
    lastSeenAt: string | null;
    applicationUrl: string;
  }[];
  windowDays: number;
  inactiveDays: number;
  truncated: boolean;
  complete: boolean;
}

run("M5OPEN a reviewer confirms a listing is still open", () => {
  let app: FastifyInstance;
  let submitterToken: string;
  let reviewerToken: string;
  let reviewerAccountId: number;
  const userIds: string[] = [];

  const confirm = (publicId: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${encodeURIComponent(publicId)}/confirm-open`,
      headers: bearer(token),
      ...(payload === undefined ? {} : { payload }),
    });

  const closingSoon = async (query = ""): Promise<ClosingSoonBody> => {
    const res = await app.inject({
      url: `/v1/review/closing-soon${query}`,
      headers: bearer(reviewerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const ours = (body: ClosingSoonBody) => body.items.filter((i) => i.id.startsWith(`${NS}:`));

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const submitter = await seedIdentity(EMAILS.submitter, { handle: "m5open-submitter" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m5open-reviewer",
      role: "reviewer",
    });
    userIds.push(submitter.userId, reviewer.userId);
    await seedOrganization({ slug: NS, verified: false });
    submitterToken = submitter.token;
    reviewerToken = reviewer.token;
    reviewerAccountId = reviewer.account.id;
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: `${NS}:`,
      organizationSlugs: [NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  describe("POST /v1/review/opportunities/:id/confirm-open", () => {
    it("refreshes last_seen_at, audits it, and changes nothing else", async () => {
      const before = await seed(`${NS}:confirm`, { quietDays: 80 });
      const startedAt = Date.now();

      const res = await confirm(before.publicId, reviewerToken, { note: "  checked the form  " });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.id).toBe(before.publicId);
      expect(body.previousLastSeenAt).toBe(before.lastSeenAt?.toISOString());
      expect(Date.parse(body.lastSeenAt)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(body.closesAt)).toBe(Date.parse(body.lastSeenAt) + INACTIVE_DAYS * DAY);

      const after = await rowOf(before.publicId);
      expect(after.lastSeenAt?.toISOString()).toBe(body.lastSeenAt);
      // The whole row, bar the one column: not updated_at, not content, not the reviewer pins.
      expect({ ...after, lastSeenAt: null }).toEqual({ ...before, lastSeenAt: null });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.reviewedApplicationUrl).toBe(before.reviewedApplicationUrl);
      expect(after.reviewedWebsite).toBe(before.reviewedWebsite);

      const [entry] = await auditRows(before.id);
      expect(entry?.action).toBe("update");
      expect(entry?.actorKind).toBe("user");
      expect(entry?.actorAccountId).toBe(reviewerAccountId);
      expect(entry?.actorRole).toBe("reviewer");
      expect(entry?.patch).toEqual({
        lastSeenAt: { before: before.lastSeenAt?.toISOString(), after: body.lastSeenAt },
        reason: "checked the form",
      });
    });

    it("records a default reason when the reviewer leaves no note", async () => {
      const before = await seed(`${NS}:no-note`, { quietDays: 80 });
      const res = await confirm(before.publicId, reviewerToken);
      expect(res.statusCode, res.body).toBe(200);
      const [entry] = await auditRows(before.id);
      expect((entry?.patch as { reason: string }).reason).toBe(CONFIRM_OPEN_DEFAULT_REASON);

      const blank = await confirm(before.publicId, reviewerToken, { note: "   " });
      expect(blank.statusCode, blank.body).toBe(200);
      const [second] = await auditRows(before.id);
      expect((second?.patch as { reason: string }).reason).toBe(CONFIRM_OPEN_DEFAULT_REASON);
    });

    it("refuses anybody who is not a reviewer", async () => {
      const before = await seed(`${NS}:not-yours`, { quietDays: 80 });
      const res = await confirm(before.publicId, submitterToken, {});
      expect(res.statusCode).toBe(403);
      const anonymous = await app.inject({
        method: "POST",
        url: `/v1/review/opportunities/${encodeURIComponent(before.publicId)}/confirm-open`,
        payload: {},
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await rowOf(before.publicId)).lastSeenAt).toEqual(before.lastSeenAt);
      expect(await auditRows(before.id)).toHaveLength(0);
    });

    it("refuses an entry that is closed, unapproved, unlisted, merged, past due or deadline-bound — and touches none", async () => {
      const closed = await seed(`${NS}:closed`, { quietDays: 80, status: "closed" });
      const pending = await seed(`${NS}:pending`, {
        quietDays: 80,
        reviewStatus: "pending",
        isListed: false,
      });
      const unlisted = await seed(`${NS}:unlisted`, { quietDays: 80, isListed: false });
      const survivor = await seed(`${NS}:survivor`, { quietDays: 1 });
      const merged = await seed(`${NS}:merged`, { quietDays: 80 });
      // Every fixed deadline passed, no rolling intake: the job closes it on its deadlines tonight
      // whatever its clock says, so a confirmation would be recorded and change nothing.
      const pastDue = await seed(`${NS}:past-due`, {
        quietDays: 80,
        deadlines: [fixed(new Date(Date.now() - 2 * DAY))],
      });
      // Fixed deadlines, no rolling intake: it closes at its final deadline whatever a confirmation
      // says, so the API refuses rather than record an extension that will not happen.
      const fixedOnly = await seed(`${NS}:fixed-only`, {
        quietDays: 80,
        deadlines: [fixed(new Date(Date.now() + 20 * DAY))],
      });
      // Rolling, but its last fixed deadline outlasts a fresh clock: a confirmation moves nothing.
      const rollingFar = await seed(`${NS}:rolling-far`, {
        quietDays: 80,
        deadlines: [{ deadlineType: "rolling" }, fixed(new Date(Date.now() + 120 * DAY))],
      });
      await db
        .update(opportunities)
        .set({ mergedIntoId: survivor.id })
        .where(eq(opportunities.id, merged.id));

      const cases: [OpportunityRow, string][] = [
        [closed, "not_open"],
        [pending, "not_approved"],
        [unlisted, "not_listed"],
        [merged, "opportunity_merged"],
        [pastDue, "past_due"],
        [fixedOnly, "closes_on_deadline"],
        [rollingFar, "closes_on_deadline"],
      ];
      for (const [row, code] of cases) {
        const res = await confirm(row.publicId, reviewerToken, {});
        expect(res.statusCode, `${row.publicId}: ${res.body}`).toBe(409);
        expect(res.json().error, row.publicId).toBe(code);
        expect((await rowOf(row.publicId)).lastSeenAt, row.publicId).toEqual(row.lastSeenAt);
        expect(await auditRows(row.id), row.publicId).toHaveLength(0);
      }

      const missing = await confirm(`${NS}:nobody`, reviewerToken, {});
      expect(missing.statusCode).toBe(404);
    });

    it("refuses a note longer than the audit trail should carry", async () => {
      const before = await seed(`${NS}:long-note`, { quietDays: 80 });
      const res = await confirm(before.publicId, reviewerToken, { note: "x".repeat(501) });
      expect(res.statusCode).toBe(400);
      expect(await auditRows(before.id)).toHaveLength(0);
    });
  });

  describe("GET /v1/review/closing-soon", () => {
    let soon: OpportunityRow;
    let sooner: OpportunityRow;
    let overdue: OpportunityRow;
    let later: OpportunityRow;
    let deadlineInWindow: OpportunityRow;
    let deadlinePassed: OpportunityRow;
    let deadlineBeyond: OpportunityRow;
    let fixedOnly: OpportunityRow;
    let pastDue: OpportunityRow;
    let hidden: OpportunityRow;
    let tieA: OpportunityRow;
    let tieB: OpportunityRow;

    beforeAll(async () => {
      soon = await seed(`${NS}:cs-soon`, { quietDays: 75 }); // closes in 15 days
      sooner = await seed(`${NS}:cs-sooner`, { quietDays: 85 }); // closes in 5 days
      overdue = await seed(`${NS}:cs-overdue`, { quietDays: 95 }); // the next run closes it
      later = await seed(`${NS}:cs-later`, { quietDays: 30 }); // closes in 60 days
      // Quiet for 100 days, but a fixed deadline 10 days ahead keeps it open until then; after it,
      // the clock has long run out, so the job closes it as inactive on day 10.
      deadlineInWindow = await seed(`${NS}:cs-deadline-in-window`, {
        quietDays: 100,
        deadlines: [{ deadlineType: "rolling" }, fixed(new Date(Date.now() + 10 * DAY))],
      });
      // Its clock ran out 10 days ago, but its deadline passed only 3 days ago: the rule was not
      // `inactive` before the deadline, so the projection is the deadline, not the clock.
      deadlinePassed = await seed(`${NS}:cs-deadline-passed`, {
        quietDays: 100,
        deadlines: [{ deadlineType: "rolling" }, fixed(new Date(Date.now() - 3 * DAY))],
      });
      // The same, with the deadline 45 days ahead: outside a 30-day window.
      deadlineBeyond = await seed(`${NS}:cs-deadline-beyond`, {
        quietDays: 100,
        deadlines: [{ deadlineType: "rolling" }, fixed(new Date(Date.now() + 45 * DAY))],
      });
      // Fixed deadlines and no rolling intake, quiet throughout: the job's predicate is `inactive`
      // at exactly the final deadline and `past_due` from just after it — listed at that instant.
      fixedOnly = await seed(`${NS}:cs-fixed-only`, {
        quietDays: 100,
        deadlines: [fixed(new Date(Date.now() + 12 * DAY))],
      });
      pastDue = await seed(`${NS}:cs-past-due`, {
        quietDays: 85,
        deadlines: [fixed(new Date(Date.now() - 10 * DAY))],
      });
      hidden = await seed(`${NS}:cs-hidden`, { quietDays: 85, isListed: false });
      // Two rows on the SAME clock, to the microsecond: the keyset cursor has to separate them by id.
      tieA = await seed(`${NS}:cs-tie-a`, { quietDays: 70 });
      tieB = await seed(`${NS}:cs-tie-b`, { quietDays: 70 });
      await db
        .update(opportunities)
        // `now()` is fixed for the statement and carries microseconds: both rows get the same value.
        .set({ lastSeenAt: sql`now() - interval '70 days'` })
        .where(inArray(opportunities.id, [tieA.id, tieB.id]));
      tieA = await rowOf(tieA.publicId);
      tieB = await rowOf(tieB.publicId);
    });

    it("refuses anybody who is not a reviewer", async () => {
      const res = await app.inject({
        url: "/v1/review/closing-soon",
        headers: bearer(submitterToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("lists what the inactivity pass closes inside the window, soonest first", async () => {
      const body = await closingSoon();
      expect(body.windowDays).toBe(30);
      expect(body.inactiveDays).toBe(INACTIVE_DAYS);
      expect(body.complete).toBe(true);
      const ids = ours(body).map((i) => i.id);
      expect(ids.filter((id) => id.startsWith(`${NS}:cs-`))).toEqual([
        overdue.publicId,
        deadlinePassed.publicId,
        sooner.publicId,
        deadlineInWindow.publicId,
        fixedOnly.publicId,
        soon.publicId,
        tieA.publicId,
        tieB.publicId,
      ]);
      const item = ours(body).find((i) => i.id === soon.publicId);
      expect(item?.closesAt).toBe(
        new Date((soon.lastSeenAt as Date).getTime() + INACTIVE_DAYS * DAY).toISOString(),
      );
      expect(item?.applicationUrl).toBe(soon.applicationUrl);
      expect(item?.closesBy).toBe("inactivity");
    });

    it("lists a quiet listing at its last fixed deadline when that decides, passed or not", async () => {
      const items = ours(await closingSoon());
      for (const row of [deadlineInWindow, deadlinePassed, fixedOnly]) {
        const item = items.find((i) => i.id === row.publicId);
        const deadline = (row.deadlines ?? []).find((d) => d.deadlineType === "fixed");
        expect(item?.closesAt, row.publicId).toBe(new Date(String(deadline?.date)).toISOString());
      }
    });

    it("excludes a deadline or a clock beyond the window, past-due and unlisted entries", async () => {
      const ids = ours(await closingSoon()).map((i) => i.id);
      for (const row of [deadlineBeyond, later, pastDue, hidden]) {
        expect(ids, row.publicId).not.toContain(row.publicId);
      }
      // A wider window reaches the two that were only out of range, and still never the two the
      // job will not close for inactivity.
      const wide = ours(await closingSoon("?days=90")).map((i) => i.id);
      expect(wide).toContain(later.publicId);
      expect(wide).toContain(deadlineBeyond.publicId);
      for (const row of [pastDue, hidden]) {
        expect(wide, row.publicId).not.toContain(row.publicId);
      }
    });

    it("names the date the staleness job actually keeps — before, at and after it", async () => {
      for (const item of ours(await closingSoon("?days=90"))) {
        const row = await rowOf(item.id);
        const at = Date.parse(item.closesAt);
        expect(jobDecides(row, new Date(at - 1000)), `${item.id} just before`).toBeNull();
        // Exactly at the instant when a deadline decides it; from just after it when the clock does.
        const atIt = jobDecides(row, new Date(at));
        const after = jobDecides(row, new Date(at + 1000));
        expect([atIt, after], `${item.id} at/after`).toContain("inactive");
      }
      const final = Date.parse(
        String((fixedOnly.deadlines ?? []).find((d) => d.deadlineType === "fixed")?.date),
      );
      expect(jobDecides(fixedOnly, new Date(final))).toBe("inactive");
      expect(jobDecides(fixedOnly, new Date(final + 1))).toBe("past_due");
      for (let day = 0; day <= 90; day += 1) {
        const at = new Date(Date.now() + day * DAY);
        expect(jobDecides(pastDue, at), `past-due, day ${day}`).toBe("past_due");
      }
    });

    it("walks the real query a row at a time and gets the same answer (keyset paging)", async () => {
      const paged = new ReviewService(db, { closingSoonScan: { pageSize: 1, scanCap: 1_000_000 } });
      const whole = new ReviewService(db);
      const now = new Date();
      const a = await paged.closingSoon(90, 200, now);
      const b = await whole.closingSoon(90, 200, now);
      expect(a.complete).toBe(true);
      expect(a.items).toEqual(b.items);
      // Both rows sharing a microsecond clock are served, once each.
      const tieIds = a.items.map((i) => i.id).filter((id) => id.startsWith(`${NS}:cs-tie-`));
      expect(tieIds).toEqual([tieA.publicId, tieB.publicId]);
    });

    it("marks a listing that closes at its final deadline, and refuses to confirm it", async () => {
      const items = ours(await closingSoon());
      const byId = (row: OpportunityRow) => items.find((i) => i.id === row.publicId)?.closesBy;
      expect(byId(fixedOnly)).toBe("final_deadline");
      // A rolling programme whose deadline is sooner than a fresh clock: a confirmation does move it.
      expect(byId(deadlineInWindow)).toBe("inactivity");
      expect(byId(deadlinePassed)).toBe("inactivity");

      const refused = await confirm(fixedOnly.publicId, reviewerToken, {});
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toBe("closes_on_deadline");
      expect((await rowOf(fixedOnly.publicId)).lastSeenAt).toEqual(fixedOnly.lastSeenAt);
      expect(await auditRows(fixedOnly.id)).toHaveLength(0);
    });

    it("reads every page from one snapshot: a refresh committed mid-walk is not read twice", async () => {
      // Seeded here so the other tests' exact orderings are untouched. Closes in 2 days; refreshed
      // to closing in 89 — still inside a 365-day window, and past the cursor once moved.
      const moved = await seed(`${NS}:cs-moved`, { quietDays: 88 });
      const expected = new Date((moved.lastSeenAt as Date).getTime() + INACTIVE_DAYS * DAY);
      let refreshed = false;
      // How many times the walk was SERVED this row. One snapshot: once. A fresh snapshot per page
      // (READ COMMITTED) would serve it again past the cursor — the de-duplication would then be the
      // only thing hiding it, which is not what this test is about.
      let served = 0;
      const service = new ReviewService(db, {
        closingSoonScan: {
          pageSize: 1,
          scanCap: 1_000_000,
          afterPage: async (rows) => {
            served += rows.filter((row) => row.id === moved.id).length;
            if (refreshed || !rows.some((row) => row.id === moved.id)) return;
            refreshed = true;
            // Through the shared pool: another connection, committed before the next page is read.
            await db
              .update(opportunities)
              .set({ lastSeenAt: new Date(Date.now() - DAY) })
              .where(eq(opportunities.id, moved.id));
          },
        },
      });
      const result = await service.closingSoon(365, 200);
      expect(refreshed).toBe(true);
      expect(served).toBe(1);
      const hits = result.items.filter((i) => i.id === moved.publicId);
      expect(hits).toHaveLength(1);
      // The snapshot's answer, not the moved one.
      expect(hits[0]?.closesAt).toBe(expected.toISOString());
      expect(new Set(result.items.map((i) => i.id)).size).toBe(result.items.length);
      expect(result.complete).toBe(true);
      // The refresh did commit; a new read sees it.
      const after = await new ReviewService(db).closingSoon(365, 200);
      const again = after.items.find((i) => i.id === moved.publicId);
      expect(Date.parse(String(again?.closesAt))).toBeGreaterThan(expected.getTime());
    });

    it("reports an incomplete answer when the safety cap stops the walk", async () => {
      const capped = new ReviewService(db, { closingSoonScan: { pageSize: 1, scanCap: 1 } });
      const result = await capped.closingSoon(90, 200);
      expect(result.complete).toBe(false);
    });

    it("drops a listing once a reviewer confirms it, and honours the limit", async () => {
      const confirmed = await confirm(sooner.publicId, reviewerToken, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(ours(await closingSoon()).map((i) => i.id)).not.toContain(sooner.publicId);

      const limited = await closingSoon("?limit=1");
      expect(limited.items).toHaveLength(1);
      expect(limited.truncated).toBe(true);
    });

    it("rejects a window it cannot honour", async () => {
      for (const query of ["?days=0", "?days=366", "?limit=0", "?other=1"]) {
        const res = await app.inject({
          url: `/v1/review/closing-soon${query}`,
          headers: bearer(reviewerToken),
        });
        expect(res.statusCode, query).toBe(400);
      }
    });
  });
});
