/** Stale-reminder opt-out end to end, and the pending-guard tripwire. */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { type DB, db, pool } from "../../src/db/client.js";
import { accounts, notifications, opportunities } from "../../src/db/schema.js";
import { repositories } from "../../src/modules/repositories/index.js";
import type {
  OutboundEmail,
  OutboundEmailPort,
  SendResult,
} from "../../src/modules/services/email/email.service.js";
import { StaleListingReminderService } from "../../src/modules/services/jobs/stale-listing-reminder.service.js";
import {
  NOTIFICATION_EMAIL_MAX_ATTEMPTS,
  NotificationDispatchService,
} from "../../src/modules/services/notifications/notification-dispatch.service.js";
import {
  signUnsubscribeToken,
  unsubscribeUrl,
} from "../../src/modules/services/notifications/unsubscribe-token.js";
import { grantMembership, seedIdentity, seedOrganization, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const API_BASE_URL = "https://api.example.org";
const EMAILS = {
  staying: "m5optout-staying@rfphub.invalid",
  leaving: "m5optout-leaving@rfphub.invalid",
};
const HANDLES = ["m5optout-staying", "m5optout-leaving"];
const ORGS = { stale: "m5optout-stale" };
const reminderConfig = {
  ...config,
  notifications: {
    ...config.notifications,
    staleReminderInactivityDays: 60,
    staleReminderCooldownDays: 30,
  },
};

class CaptureEmail implements OutboundEmailPort {
  readonly sent: OutboundEmail[] = [];

  async send(message: OutboundEmail): Promise<SendResult> {
    this.sent.push(message);
    return { status: "sent" };
  }
}

function token(accountId: number): string {
  return signUnsubscribeToken(config.betterAuth.secret, accountId, "stale_listing_reminder");
}

async function optedOutAt(accountId: number): Promise<Date | null> {
  const rows = await db
    .select({ at: accounts.staleRemindersOptedOutAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return rows[0]?.at ?? null;
}

async function staleRows(accountId: number, organizationId: number, exec: DB = db) {
  return exec
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.kind, "stale_listing_reminder"),
        sql`${notifications.payload} ->> 'organizationId' = ${String(organizationId)}`,
      ),
    );
}

describeWithDb("stale reminder opt-out", () => {
  let app: FastifyInstance;
  let stayingId: number;
  let leavingId: number;
  let staleOrgId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const staying = await seedIdentity(EMAILS.staying, { handle: HANDLES[0] });
    const leaving = await seedIdentity(EMAILS.leaving, { handle: HANDLES[1] });
    stayingId = staying.account.id;
    leavingId = leaving.account.id;
    userIds.push(staying.userId, leaving.userId);

    const staleOrg = await seedOrganization({ slug: ORGS.stale, verified: true });
    staleOrgId = staleOrg.id;
    await grantMembership(stayingId, staleOrgId, "owner");
    await grantMembership(leavingId, staleOrgId, "publisher");
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m5optout:",
      organizationSlugs: Object.values(ORGS),
      userIds,
      handles: HANDLES,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  });

  describe("unsubscribe routes", () => {
    it("serves a confirmation form on GET without opting out", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/email/unsubscribe?token=${token(leavingId)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.body).toContain('<form method="post">');
      expect(await optedOutAt(leavingId)).toBeNull();
    });

    it("rejects a forged token as HTML and a malformed one as JSON", async () => {
      const forged = `${leavingId}.${"A".repeat(43)}`;
      const bad = await app.inject({ method: "GET", url: `/v1/email/unsubscribe?token=${forged}` });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers["content-type"]).toContain("text/html");
      const post = await app.inject({
        method: "POST",
        url: `/v1/email/unsubscribe?token=${forged}`,
      });
      expect(post.statusCode).toBe(400);
      const malformed = await app.inject({ method: "GET", url: "/v1/email/unsubscribe?token=x" });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toBe("bad_request");
      expect(await optedOutAt(leavingId)).toBeNull();
    });

    it("records a one-click POST idempotently, whatever the body encoding", async () => {
      const url = `/v1/email/unsubscribe?token=${token(leavingId)}`;
      const first = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "List-Unsubscribe=One-Click",
      });
      expect(first.statusCode).toBe(200);
      const recorded = await optedOutAt(leavingId);
      expect(recorded).not.toBeNull();

      const again = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload:
          '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--x--\r\n',
      });
      expect(again.statusCode).toBe(200);
      expect(await optedOutAt(leavingId)).toEqual(recorded);
    });
  });

  it("skips opted-out accounts when generating and fails closed on already-queued reminders", async () => {
    // Uncommitted, on a historical clock: the reminder generator scans every publisher, and other
    // suites assert exact counts from their own runs.
    const rollback = new Error("rollback generator fixture");
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(opportunities).values({
          publicId: "m5optout:quiet",
          fundingType: "grant",
          status: "open",
          title: "Opt-out fixture",
          description: "A stale listing for the opt-out suite.",
          sponsoringOrganizations: [],
          operatingOrganizations: [{ name: ORGS.stale, slug: ORGS.stale }],
          orgSlugs: [ORGS.stale],
          ecosystems: ["M5OPTOUT"],
          categories: [],
          deadlines: [],
          typeData: { fundingType: "grant" },
          sourcePublisher: ORGS.stale,
          sourceSubmittedBy: ORGS.stale,
          reviewStatus: "approved",
          isListed: true,
          lastSeenAt: new Date("1999-01-01T00:00:00.000Z"),
          updatedAt: new Date("1999-01-01T00:00:00.000Z"),
        });
        const executor = tx as unknown as DB;
        await new StaleListingReminderService(executor, { config: reminderConfig }).runBatch({
          now: new Date("2000-01-01T00:00:00.000Z"),
        });
        expect(await staleRows(stayingId, staleOrgId, executor)).toHaveLength(1);
        expect(await staleRows(leavingId, staleOrgId, executor)).toHaveLength(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    const queued = await repositories(db).notifications.record([
      {
        accountId: leavingId,
        kind: "stale_listing_reminder",
        subjectKind: `email:stale-listing:${staleOrgId}:queued-before-opt-out`,
        subjectId: leavingId,
        payload: {
          organizationId: staleOrgId,
          organizationSlug: ORGS.stale,
          organizationName: ORGS.stale,
          listings: [{ id: "m5optout:quiet", title: "Opt-out fixture" }],
          inactivityDays: 60,
          closeAfterDays: 90,
        },
      },
    ]);
    const queuedId = queued[0];
    if (queuedId === undefined) throw new Error("queued reminder fixture was not inserted");

    const email = new CaptureEmail();
    const dispatch = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl: "https://app.example.org",
      unsubscribe: { apiBaseUrl: API_BASE_URL, secret: config.betterAuth.secret },
      accountId: leavingId,
      logger: { error() {} },
    });
    const result = await dispatch.runBatch({ now: NOW, notificationIds: [queuedId] });
    expect(result).toMatchObject({ details: { failed: 1, recipientOptedOut: 1 } });
    expect(email.sent).toHaveLength(0);
    const [row] = await staleRows(leavingId, staleOrgId);
    expect(row?.emailFailedAt).not.toBeNull();
    expect(row?.payload.emailDelivery).toEqual({
      attempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
      failure: "recipient_opted_out",
    });
  });

  it("sends reminders with RFC 8058 headers whose link opts the recipient out", async () => {
    const [pendingId] = await repositories(db).notifications.record([
      {
        accountId: stayingId,
        kind: "stale_listing_reminder",
        subjectKind: `email:stale-listing:${staleOrgId}:pending`,
        subjectId: stayingId,
        payload: {
          organizationId: staleOrgId,
          organizationSlug: ORGS.stale,
          organizationName: ORGS.stale,
          listings: [{ id: "m5optout:quiet", title: "Opt-out fixture" }],
          inactivityDays: 60,
          closeAfterDays: 90,
        },
      },
    ]);
    if (pendingId === undefined) throw new Error("pending reminder fixture was not inserted");
    const email = new CaptureEmail();
    const dispatch = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl: "https://app.example.org",
      unsubscribe: { apiBaseUrl: API_BASE_URL, secret: config.betterAuth.secret },
      accountId: stayingId,
    });
    await dispatch.runBatch({ now: NOW, notificationIds: [pendingId] });
    const message = email.sent[0];
    const link = unsubscribeUrl(API_BASE_URL, token(stayingId));
    expect(message?.headers).toEqual({
      "List-Unsubscribe": `<${link}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(message?.text).toContain(`Stop these reminders: ${link}`);

    const url = new URL(link);
    const response = await app.inject({ method: "POST", url: `${url.pathname}${url.search}` });
    expect(response.statusCode).toBe(200);
    expect(await optedOutAt(stayingId)).not.toBeNull();
  });

  it("keeps the pending-reminder index in step with the dispatcher's attempt ceiling", async () => {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'ux_stale_listing_pending_recipient'`,
    );
    const definition = rows.rows[0]?.indexdef ?? "";
    const ceiling = /\)\s*<\s*(\d+)\)*\s*$/.exec(definition)?.[1];
    expect(ceiling, definition).toBe(String(NOTIFICATION_EMAIL_MAX_ATTEMPTS));
  });
});
