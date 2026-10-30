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
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { type OpportunityRow, auditLog, opportunities } from "../../src/db/schema.js";
import { StalenessService } from "../../src/modules/services/jobs/staleness.service.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { CONFIRM_OPEN_DEFAULT_REASON } from "../../src/modules/services/review/review.service.js";
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
  items: { id: string; closesAt: string; lastSeenAt: string | null; applicationUrl: string }[];
  windowDays: number;
  inactiveDays: number;
  truncated: boolean;
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

    it("refuses an entry that is closed, unapproved, unlisted, merged or past due — and touches none", async () => {
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
    let deadlineBeyond: OpportunityRow;
    let fixedOnly: OpportunityRow;
    let pastDue: OpportunityRow;
    let hidden: OpportunityRow;

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
      // The same, with the deadline 45 days ahead: outside a 30-day window.
      deadlineBeyond = await seed(`${NS}:cs-deadline-beyond`, {
        quietDays: 100,
        deadlines: [{ deadlineType: "rolling" }, fixed(new Date(Date.now() + 45 * DAY))],
      });
      // Fixed deadlines and no rolling intake: when the last one passes it closes as past due,
      // never as inactive, and a confirmation could not keep it open.
      fixedOnly = await seed(`${NS}:cs-fixed-only`, {
        quietDays: 100,
        deadlines: [fixed(new Date(Date.now() + 10 * DAY))],
      });
      pastDue = await seed(`${NS}:cs-past-due`, {
        quietDays: 85,
        deadlines: [fixed(new Date(Date.now() - 10 * DAY))],
      });
      hidden = await seed(`${NS}:cs-hidden`, { quietDays: 85, isListed: false });
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
      const ids = ours(body).map((i) => i.id);
      expect(ids.filter((id) => id.startsWith(`${NS}:cs-`))).toEqual([
        overdue.publicId,
        sooner.publicId,
        deadlineInWindow.publicId,
        soon.publicId,
      ]);
      const item = ours(body).find((i) => i.id === soon.publicId);
      expect(item?.closesAt).toBe(
        new Date((soon.lastSeenAt as Date).getTime() + INACTIVE_DAYS * DAY).toISOString(),
      );
      expect(item?.applicationUrl).toBe(soon.applicationUrl);
    });

    it("lists a quiet rolling programme at its last fixed deadline when that falls in the window", async () => {
      const item = ours(await closingSoon()).find((i) => i.id === deadlineInWindow.publicId);
      const deadline = (deadlineInWindow.deadlines ?? []).find((d) => d.deadlineType === "fixed");
      expect(item?.closesAt).toBe(new Date(String(deadline?.date)).toISOString());
    });

    it("excludes a deadline or a clock beyond the window, fixed-only, past-due and unlisted entries", async () => {
      const ids = ours(await closingSoon()).map((i) => i.id);
      for (const row of [deadlineBeyond, later, fixedOnly, pastDue, hidden]) {
        expect(ids, row.publicId).not.toContain(row.publicId);
      }
      // A wider window reaches the two that were only out of range, and still never the three the
      // job will not close for inactivity.
      const wide = ours(await closingSoon("?days=90")).map((i) => i.id);
      expect(wide).toContain(later.publicId);
      expect(wide).toContain(deadlineBeyond.publicId);
      for (const row of [fixedOnly, pastDue, hidden]) {
        expect(wide, row.publicId).not.toContain(row.publicId);
      }
    });

    it("names the date the staleness job actually keeps", async () => {
      for (const item of ours(await closingSoon("?days=90"))) {
        const row = await rowOf(item.id);
        const at = Date.parse(item.closesAt);
        expect(jobDecides(row, new Date(at - 1000)), `${item.id} just before`).toBeNull();
        expect(jobDecides(row, new Date(at + 1000)), `${item.id} just after`).toBe("inactive");
      }
      // And the excluded ones are excluded for the job's reasons: never closed as inactive anywhere
      // across a 90-day window — the fixed-only one closes as past due once its deadline passes.
      for (let day = 0; day <= 90; day += 1) {
        const at = new Date(Date.now() + day * DAY);
        expect(jobDecides(fixedOnly, at), `fixed-only, day ${day}`).not.toBe("inactive");
        expect(jobDecides(pastDue, at), `past-due, day ${day}`).toBe("past_due");
      }
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
