/**
 * Notification email dispatch end to end: identity join, content, retry, idempotency and orphans.
 *
 * Isolation tag: `M3MAIL` / `m3mail-*@rfphub.invalid`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EmailConfig } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { accounts, notifications } from "../../src/db/schema.js";
import {
  type EmailTransport,
  createEmailTransport,
} from "../../src/modules/services/email/email-transport.js";
import {
  EmailService,
  type OutboundEmail,
  type OutboundEmailPort,
  type SendResult,
} from "../../src/modules/services/email/email.service.js";
import { runJob } from "../../src/modules/services/jobs/runner.js";
import { NotificationDispatchQueue } from "../../src/modules/services/notifications/notification-dispatch.queue.js";
import {
  NOTIFICATION_EMAIL_MAX_ATTEMPTS,
  NOTIFICATION_EMAIL_RETRY_DELAY_MS,
  NotificationDispatchService,
} from "../../src/modules/services/notifications/notification-dispatch.service.js";
import type { NotificationKind } from "../../src/modules/services/notifications/notification.service.js";
import { seedIdentity } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAIL = "m3mail-publisher@rfphub.invalid";
const HANDLE = "m3mail-publisher";
const ORPHAN_HANDLE = "m3mail-orphan";
const APP_BASE_URL = "https://app.example.org";
const START = new Date("2026-08-26T15:00:00.000Z");
const LOCK_URL = process.env.DATABASE_URL as string;
const emailConfig: EmailConfig = {
  transport: "memory",
  from: "no-reply@rfphub.invalid",
  outboxDir: undefined,
  sesRegion: undefined,
  resendApiKey: undefined,
  mailgunApiKey: undefined,
  mailgunDomain: undefined,
  mailgunApiBase: "https://api.mailgun.net",
};

function payload(named = true) {
  return {
    pairId: 71,
    similarity: 0.86,
    yourListing: { id: "m3mail:mine", title: "My Builders Programme" },
    ...(named ? { otherListing: { id: "m3mail:public", title: "Public Builders Programme" } } : {}),
    action: "review_match",
    link: "/duplicates",
    decidedBy: "reviewer",
  };
}

async function insertNotification(accountId: number, kind: NotificationKind, subjectId: number) {
  const rows = await db
    .insert(notifications)
    .values({
      accountId,
      kind,
      subjectKind: "duplicate",
      subjectId,
      payload: payload(),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("notification fixture was not inserted");
  return row;
}

async function rowOf(id: number) {
  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`notification ${id} disappeared`);
  return row;
}

function jobOptions(
  accountId: number,
  email: OutboundEmailPort,
  now: Date,
  clock: () => Date = () => now,
) {
  return {
    now,
    maxPasses: 1,
    lockConnectionString: LOCK_URL,
    notificationDispatch: { email, enabled: true, appBaseUrl: APP_BASE_URL, accountId, clock },
  };
}

class FailOnceEmail implements OutboundEmailPort {
  readonly sent: OutboundEmail[] = [];
  attempts = 0;

  async send(message: OutboundEmail): Promise<SendResult> {
    this.attempts++;
    if (this.attempts === 1) {
      return { status: "failed", error: "transport_failure", reason: "temporary test refusal" };
    }
    this.sent.push(message);
    return { status: "sent" };
  }
}

class AlwaysFailEmail implements OutboundEmailPort {
  attempts = 0;

  async send(): Promise<SendResult> {
    this.attempts++;
    return { status: "failed", error: "transport_failure", reason: "persistent test refusal" };
  }
}

class BlockingEmail implements OutboundEmailPort {
  readonly sent: OutboundEmail[] = [];
  private releaseAttempt: (() => void) | undefined;
  private releaseSend: (() => void) | undefined;
  readonly started: Promise<void>;
  private readonly released: Promise<void>;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.releaseAttempt = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
  }

  unblock(): void {
    this.releaseSend?.();
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    this.releaseAttempt?.();
    await this.released;
    this.sent.push(message);
    return { status: "sent" };
  }
}

async function waitForQueue(queue: NotificationDispatchQueue): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (queue.queueDepth > 0) {
    if (Date.now() >= deadline) throw new Error("notification dispatch queue did not drain");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeWithDb("M3MAIL notification dispatch", () => {
  let accountId: number;
  let userId: string;
  let orphanAccountId: number;

  beforeAll(async () => {
    await cleanupFixtures({ handles: [HANDLE, ORPHAN_HANDLE], emails: [EMAIL] });
    const publisher = await seedIdentity(EMAIL, { handle: HANDLE });
    accountId = publisher.account.id;
    userId = publisher.userId;
    const orphans = await db
      .insert(accounts)
      .values({ handle: ORPHAN_HANDLE, authUserId: null })
      .returning({ id: accounts.id });
    orphanAccountId = orphans[0]?.id ?? 0;
    if (!orphanAccountId) throw new Error("orphan account fixture was not inserted");
  });

  afterAll(async () => {
    await cleanupFixtures({
      handles: [HANDLE, ORPHAN_HANDLE],
      userIds: [userId],
      emails: [EMAIL],
    });
    await pool.end();
  });

  it("sends through memory with the joined identity address, stamps success, and is idempotent", async () => {
    const notification = await insertNotification(accountId, "duplicate_suspected", 7101);
    const transport: EmailTransport = createEmailTransport(emailConfig);
    const email = new EmailService({ config: emailConfig, transport });

    const first = await runJob("notification-dispatch", jobOptions(accountId, email, START));
    expect(first).toMatchObject({ processed: 1, details: { sent: 1, failed: 0 } });
    const messages = transport.drain?.(EMAIL) ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: EMAIL,
      subject: "A possible duplicate was found",
    });
    expect(messages[0]?.text).toContain("My Builders Programme");
    expect(messages[0]?.text).toContain("Public Builders Programme");
    expect(messages[0]?.text).toContain("https://app.example.org/duplicates");

    const delivered = await rowOf(notification.id);
    expect(delivered.emailDispatchedAt?.toISOString()).toBe(START.toISOString());
    expect(delivered.emailFailedAt).toBeNull();

    const second = await runJob(
      "notification-dispatch",
      jobOptions(accountId, email, new Date(START.getTime() + 1000)),
    );
    expect(second.processed).toBe(0);
    expect(transport.drain?.(EMAIL)).toEqual([]);
  });

  it("stamps a failure, waits for the retry floor, then retries and clears the failure state", async () => {
    const notification = await insertNotification(accountId, "duplicate_confirmed", 7102);
    const email = new FailOnceEmail();
    const completedAt = new Date(START.getTime() + NOTIFICATION_EMAIL_RETRY_DELAY_MS + 30_000);
    const failed = await runJob(
      "notification-dispatch",
      jobOptions(accountId, email, START, () => completedAt),
    );
    expect(failed).toMatchObject({ processed: 1, remaining: 1, details: { failed: 1 } });
    const afterFailure = await rowOf(notification.id);
    expect(afterFailure.emailDispatchedAt).toBeNull();
    expect(afterFailure.emailFailedAt?.toISOString()).toBe(completedAt.toISOString());
    expect(afterFailure.payload.emailDelivery).toEqual({
      attempts: 1,
      failure: "transport_failure",
    });

    const tooSoon = await runJob(
      "notification-dispatch",
      jobOptions(
        accountId,
        email,
        new Date(completedAt.getTime() + NOTIFICATION_EMAIL_RETRY_DELAY_MS - 1),
      ),
    );
    expect(tooSoon.processed).toBe(0);
    expect(email.attempts).toBe(1);

    const retriedAt = new Date(completedAt.getTime() + NOTIFICATION_EMAIL_RETRY_DELAY_MS);
    const retried = await runJob("notification-dispatch", jobOptions(accountId, email, retriedAt));
    expect(retried).toMatchObject({ processed: 1, details: { sent: 1, retried: 1 } });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe(EMAIL);
    const recovered = await rowOf(notification.id);
    expect(recovered.emailDispatchedAt?.toISOString()).toBe(retriedAt.toISOString());
    expect(recovered.emailFailedAt).toBeNull();
    expect(recovered.payload).not.toHaveProperty("emailDelivery");
  });

  it("marks an account with no identity email as a distinct terminal failure", async () => {
    const notification = await insertNotification(orphanAccountId, "duplicate_dismissed", 7103);
    const transport = createEmailTransport(emailConfig);
    const email = new EmailService({ config: emailConfig, transport });
    const result = await runJob("notification-dispatch", jobOptions(orphanAccountId, email, START));
    expect(result).toMatchObject({
      processed: 1,
      remaining: 0,
      details: { failed: 1, recipientUnavailable: 1 },
    });
    const failed = await rowOf(notification.id);
    expect(failed.emailFailedAt?.toISOString()).toBe(START.toISOString());
    expect(failed.payload.emailDelivery).toEqual({
      attempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
      failure: "recipient_unavailable",
    });
    expect(transport.drain?.(EMAIL)).toEqual([]);

    const repeated = await runJob(
      "notification-dispatch",
      jobOptions(orphanAccountId, email, new Date(START.getTime() + 86_400_000)),
    );
    expect(repeated.processed).toBe(0);
  });

  it("bounds persistent transport failures at three attempts", async () => {
    const notification = await insertNotification(accountId, "duplicate_reopened", 7104);
    const email = new AlwaysFailEmail();
    for (let attempt = 0; attempt < NOTIFICATION_EMAIL_MAX_ATTEMPTS; attempt++) {
      const now = new Date(START.getTime() + attempt * NOTIFICATION_EMAIL_RETRY_DELAY_MS);
      const result = await runJob("notification-dispatch", jobOptions(accountId, email, now));
      expect(result.processed, `attempt ${attempt + 1}`).toBe(1);
    }
    const exhausted = await rowOf(notification.id);
    expect(exhausted.payload.emailDelivery).toEqual({
      attempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
      failure: "transport_failure",
    });

    const fourth = await runJob(
      "notification-dispatch",
      jobOptions(
        accountId,
        email,
        new Date(
          START.getTime() + NOTIFICATION_EMAIL_MAX_ATTEMPTS * NOTIFICATION_EMAIL_RETRY_DELAY_MS,
        ),
      ),
    );
    expect(fourth).toMatchObject({ processed: 0, remaining: 0 });
    expect(email.attempts).toBe(NOTIFICATION_EMAIL_MAX_ATTEMPTS);
  });

  it("rejects newest ids when the immediate queue is full and leaves them untouched for the sweep", async () => {
    const first = await insertNotification(accountId, "duplicate_suspected", 7110);
    const second = await insertNotification(accountId, "duplicate_suspected", 7111);
    const rejected = await insertNotification(accountId, "duplicate_suspected", 7112);
    const email = new BlockingEmail();
    const dispatcher = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl: APP_BASE_URL,
      accountId,
    });
    const queue = new NotificationDispatchQueue({ queueMax: 1, dispatcher });

    queue.enqueue([first.id, second.id, rejected.id]);
    await email.started;
    expect(queue.queueDepth).toBe(2);
    email.unblock();
    await waitForQueue(queue);

    expect((await rowOf(first.id)).emailDispatchedAt).not.toBeNull();
    expect((await rowOf(second.id)).emailDispatchedAt).not.toBeNull();
    const pending = await rowOf(rejected.id);
    expect(pending.emailDispatchedAt).toBeNull();
    expect(pending.emailFailedAt).toBeNull();
    expect(pending.payload).not.toHaveProperty("emailDelivery");

    const sweepTransport = createEmailTransport(emailConfig);
    const sweepEmail = new EmailService({ config: emailConfig, transport: sweepTransport });
    const swept = await runJob(
      "notification-dispatch",
      jobOptions(accountId, sweepEmail, new Date(START.getTime() + 86_400_000)),
    );
    expect(swept).toMatchObject({ processed: 1, details: { sent: 1 } });
    expect((await rowOf(rejected.id)).emailDispatchedAt).not.toBeNull();
    expect(sweepTransport.drain?.(EMAIL)).toHaveLength(1);
  });

  it("contains an immediate transport failure and leaves the row retryable by the sweep", async () => {
    const notification = await insertNotification(accountId, "duplicate_confirmed", 7113);
    const email = new AlwaysFailEmail();
    const queue = new NotificationDispatchQueue({
      queueMax: 1,
      dispatcher: new NotificationDispatchService(db, {
        email,
        enabled: true,
        appBaseUrl: APP_BASE_URL,
        accountId,
      }),
    });

    expect(() => queue.enqueue([notification.id])).not.toThrow();
    await waitForQueue(queue);

    const pending = await rowOf(notification.id);
    expect(pending.emailDispatchedAt).toBeNull();
    expect(pending.emailFailedAt).not.toBeNull();
    expect(pending.payload.emailDelivery).toEqual({
      attempts: 1,
      failure: "transport_failure",
    });
  });

  it("uses the dispatcher's skipped no-op when immediate email delivery is not configured", async () => {
    const notification = await insertNotification(accountId, "duplicate_dismissed", 7114);
    const queue = new NotificationDispatchQueue({
      queueMax: 1,
      dispatcher: new NotificationDispatchService(db, { enabled: false, accountId }),
    });

    queue.enqueue([notification.id]);
    await waitForQueue(queue);

    const untouched = await rowOf(notification.id);
    expect(untouched.emailDispatchedAt).toBeNull();
    expect(untouched.emailFailedAt).toBeNull();
  });
});
