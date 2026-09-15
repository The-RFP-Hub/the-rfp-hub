/** M5 lifecycle email evidence: signup, verified publisher transitions, stale eligibility, and delivery. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/better-auth.js";
import { config } from "../../src/config.js";
import { authUser } from "../../src/db/auth-schema.js";
import { type DB, db, pool } from "../../src/db/client.js";
import {
  accounts,
  notifications,
  opportunities,
  orgMemberships,
  organizations,
} from "../../src/db/schema.js";
import { AccountService } from "../../src/modules/services/auth/account.service.js";
import { createEmailTransport } from "../../src/modules/services/email/email-transport.js";
import type {
  OutboundEmail,
  OutboundEmailPort,
  SendResult,
} from "../../src/modules/services/email/email.service.js";
import { EmailService } from "../../src/modules/services/email/email.service.js";
import { runJob } from "../../src/modules/services/jobs/runner.js";
import { StaleListingReminderService } from "../../src/modules/services/jobs/stale-listing-reminder.service.js";
import { notificationDispatchQueue } from "../../src/modules/services/notifications/notification-dispatch.queue.js";
import { NotificationDispatchService } from "../../src/modules/services/notifications/notification-dispatch.service.js";
import { NOTIFICATION_EMAIL_RETRY_DELAY_MS } from "../../src/modules/services/notifications/notification-dispatch.service.js";
import { NotificationService } from "../../src/modules/services/notifications/notification.service.js";
import { ReviewService } from "../../src/modules/services/review/review.service.js";
import {
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuthConfig,
  unsignedToken,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const STALE_AT = new Date("2026-06-01T00:00:00.000Z");
const EMAILS = {
  publisher: "m5email-publisher@rfphub.invalid",
  revoked: "m5email-revoked@rfphub.invalid",
  reviewer: "m5email-reviewer@rfphub.invalid",
  injected: "m5email-injected@rfphub.invalid",
  queueFailure: "m5email-queue-failure@rfphub.invalid",
  legacy: "m5email-legacy@rfphub.invalid",
};
const HANDLES = {
  publisher: "m5email-publisher",
  revoked: "m5email-revoked",
  reviewer: "m5email-reviewer",
} as const;
const ORGS = {
  publisher: "m5email",
  unowned: "m5email-unowned",
  verify: "m5email-verify",
  cooldown: "m5email-cooldown",
  pageExpired: "m5email-page-expired",
  pageEligible: "m5email-page-eligible",
  multi: "m5email-multi",
  concurrent: "m5email-concurrent",
  registry: "m5email-registry",
  terminal: "m5email-terminal",
} as const;
const appBaseUrl = "https://app.example.org";
const reminderConfig = {
  ...config,
  notifications: {
    ...config.notifications,
    staleReminderInactivityDays: 60,
    staleReminderCooldownDays: 30,
  },
};

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

class CaptureEmail implements OutboundEmailPort {
  readonly sent: OutboundEmail[] = [];

  async send(message: OutboundEmail): Promise<SendResult> {
    this.sent.push(message);
    return { status: "sent" };
  }
}

async function insertListing(
  name: string,
  organizationSlug: string,
  overrides: Partial<typeof opportunities.$inferInsert> = {},
): Promise<number> {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: `m5email:${name}`,
      fundingType: "grant",
      status: "open",
      title: `Fixture ${name}`,
      description: "An M5 lifecycle email fixture.",
      sponsoringOrganizations: [],
      operatingOrganizations: [{ name: organizationSlug, slug: organizationSlug }],
      orgSlugs: [organizationSlug],
      ecosystems: ["M5EMAIL"],
      categories: [],
      deadlines: [],
      typeData: { fundingType: "grant" },
      sourcePublisher: organizationSlug,
      sourceSubmittedBy: organizationSlug,
      reviewStatus: "approved",
      isListed: true,
      lastSeenAt: STALE_AT,
      updatedAt: STALE_AT,
      ...overrides,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`could not insert listing ${name}`);
  return id;
}

describeWithDb("M5 lifecycle email events", () => {
  let publisherAccountId: number;
  let publisherUserId: string;
  let revokedAccountId: number;
  let revokedUserId: string;
  let reviewerAccountId: number;
  let reviewerUserId: string;
  let publisherOrganizationId: number;
  let verifyOrganizationId: number;
  let staleReminderId: number;

  beforeAll(async () => {
    const publisher = await seedIdentity(EMAILS.publisher, { handle: HANDLES.publisher });
    const revoked = await seedIdentity(EMAILS.revoked, { handle: HANDLES.revoked });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: HANDLES.reviewer,
      role: "reviewer",
    });
    publisherAccountId = publisher.account.id;
    publisherUserId = publisher.userId;
    revokedAccountId = revoked.account.id;
    revokedUserId = revoked.userId;
    reviewerAccountId = reviewer.account.id;
    reviewerUserId = reviewer.userId;

    const publisherOrganization = await seedOrganization({
      slug: ORGS.publisher,
      name: "M5 Publisher",
      verified: true,
    });
    await seedOrganization({
      slug: ORGS.unowned,
      name: "M5 Unowned",
      verified: true,
    });
    const verifyOrganization = await seedOrganization({
      slug: ORGS.verify,
      name: "M5 Verify",
      verified: false,
    });
    publisherOrganizationId = publisherOrganization.id;
    verifyOrganizationId = verifyOrganization.id;
    await grantMembership(publisherAccountId, publisherOrganization.id, "owner");
    await grantMembership(revokedAccountId, publisherOrganization.id, "publisher");
    await grantMembership(reviewerAccountId, verifyOrganization.id, "publisher");

    await insertListing("eligible", ORGS.publisher);
    await insertListing("recent", ORGS.publisher, {
      lastSeenAt: new Date("2026-08-15T00:00:00.000Z"),
    });
    await insertListing("future-deadline", ORGS.publisher, {
      deadlines: [{ deadlineType: "fixed", date: "2026-12-31T00:00:00.000Z" }],
      nextDeadlineAt: new Date("2026-12-31T00:00:00.000Z"),
    });
    await insertListing("past-due", ORGS.publisher, {
      deadlines: [{ deadlineType: "fixed", date: "2026-08-01T00:00:00.000Z" }],
    });
    await insertListing("unowned", ORGS.unowned);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m5email:",
      organizationSlugs: Object.values(ORGS),
      userIds: [publisherUserId, revokedUserId, reviewerUserId],
      handles: Object.values(HANDLES),
      emails: Object.values(EMAILS),
    });
    await pool.end();
  });

  it("records one welcome on actual signup and no duplicate on repeated resolution", async () => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.accountId, publisherAccountId), eq(notifications.kind, "welcome")),
      );
    expect(rows).toHaveLength(1);

    const queueIds: number[] = [];
    const service = new AccountService(db, undefined, { enqueue: (ids) => queueIds.push(...ids) });
    await service.resolveBySubject(publisherUserId);
    await service.resolveBySubject(publisherUserId);
    // A second real OTP login does not re-run the user-create hook or emit another welcome.
    await unsignedToken(EMAILS.publisher);

    const repeated = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.accountId, publisherAccountId), eq(notifications.kind, "welcome")),
      );
    expect(repeated).toHaveLength(1);
    expect(queueIds).toHaveLength(0);
  });

  it("sends an OTP signup welcome through the auth instance's injected transport without /v1", async () => {
    const authConfig = testAuthConfig();
    const transport = createEmailTransport(authConfig.email);
    const auth = createAuth({
      db,
      config: authConfig,
      email: new EmailService({ config: authConfig.email, transport }),
    });
    await auth.api.sendVerificationOTP({ body: { email: EMAILS.injected, type: "sign-in" } });
    const code = /\b(\d{6})\b/.exec(transport.drain?.(EMAILS.injected)?.[0]?.text ?? "")?.[1];
    if (code === undefined) throw new Error("injected auth fixture did not receive an OTP");

    const signedIn = await auth.api.signInEmailOTP({
      body: { email: EMAILS.injected, otp: code },
      returnHeaders: true,
    });
    expect(signedIn.headers.get("set-auth-token")).toBeTruthy();

    const account = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.authUserId, signedIn.response.user.id))
      .limit(1);
    expect(account).toHaveLength(1);
    const messages: OutboundEmail[] = [];
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt++) {
      messages.push(...(transport.drain?.(EMAILS.injected) ?? []));
      if (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(messages.some((message) => message.subject === "Welcome to RFP Hub")).toBe(true);
  }, 60_000);

  it("keeps OTP signup successful when the injected post-commit queue fails", async () => {
    const authConfig = testAuthConfig();
    const transport = createEmailTransport(authConfig.email);
    const auth = createAuth({
      db,
      config: authConfig,
      email: new EmailService({ config: authConfig.email, transport }),
      notificationQueue: {
        enqueue() {
          throw new Error("test queue failure");
        },
      },
    });
    await auth.api.sendVerificationOTP({ body: { email: EMAILS.queueFailure, type: "sign-in" } });
    const code = /\b(\d{6})\b/.exec(transport.drain?.(EMAILS.queueFailure)?.[0]?.text ?? "")?.[1];
    if (code === undefined) throw new Error("queue failure fixture did not receive an OTP");
    await expect(
      auth.api.signInEmailOTP({ body: { email: EMAILS.queueFailure, otp: code } }),
    ).resolves.toBeDefined();
  }, 60_000);

  it("keeps legacy auth-user login lazy and does not create a new welcome event", async () => {
    const legacyUserId = "m5email-legacy-user";
    await db.insert(authUser).values({
      id: legacyUserId,
      name: "Legacy M5",
      email: EMAILS.legacy,
      emailVerified: true,
    });
    const authConfig = testAuthConfig();
    const transport = createEmailTransport(authConfig.email);
    const auth = createAuth({
      db,
      config: authConfig,
      email: new EmailService({ config: authConfig.email, transport }),
    });
    await auth.api.sendVerificationOTP({ body: { email: EMAILS.legacy, type: "sign-in" } });
    const code = /\b(\d{6})\b/.exec(transport.drain?.(EMAILS.legacy)?.[0]?.text ?? "")?.[1];
    if (code === undefined) throw new Error("legacy auth fixture did not receive an OTP");
    await expect(
      auth.api.signInEmailOTP({ body: { email: EMAILS.legacy, otp: code } }),
    ).resolves.toBeDefined();
    const welcomesAfterLogin = await db
      .select({ id: notifications.id })
      .from(notifications)
      .innerJoin(accounts, eq(accounts.id, notifications.accountId))
      .where(and(eq(notifications.kind, "welcome"), eq(accounts.authUserId, legacyUserId)));
    expect(welcomesAfterLogin).toHaveLength(0);

    // Whether the library eagerly repairs this legacy account or the first versioned API request
    // does it, there is no signup boundary to report and no welcome row is synthesized.
    await new AccountService(db).resolveBySubject(legacyUserId, EMAILS.legacy);
    const welcomes = await db
      .select({ id: notifications.id })
      .from(notifications)
      .innerJoin(accounts, eq(accounts.id, notifications.accountId))
      .where(and(eq(notifications.kind, "welcome"), eq(accounts.authUserId, legacyUserId)));
    expect(welcomes).toHaveLength(0);
  }, 60_000);

  it("records only eligible listings and suppresses reminders during the rolling cooldown", async () => {
    const service = new StaleListingReminderService(db, {
      config: reminderConfig,
    });
    const first = await service.runBatch({ now: NOW });
    expect(first).toMatchObject({
      processed: 2,
      details: {
        eligibleListings: 2,
        recipientGroups: 2,
        createdNotifications: 2,
        skippedPastDue: 2,
      },
    });
    const second = await service.runBatch({ now: new Date(NOW.getTime() + 86_400_000) });
    expect(second.processed).toBe(0);
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.kind, "stale_listing_reminder"),
          inArray(notifications.accountId, [publisherAccountId, revokedAccountId]),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.emailDispatchedAt === null)).toBe(true);
    staleReminderId = rows.find((row) => row.accountId === publisherAccountId)?.id ?? 0;
    expect(staleReminderId).toBeGreaterThan(0);
    expect(rows.every((row) => row.subjectKind.startsWith("email:stale-listing:"))).toBe(true);
    expect(rows.every((row) => row.payload.organizationId === publisherOrganizationId)).toBe(true);

    const inbox = await new NotificationService(db).listForAccount(publisherAccountId);
    expect(inbox.items.every((item) => item.kind.startsWith("duplicate_"))).toBe(true);
  });

  it("uses a rolling created/sent cooldown across UTC boundaries and allows the exact interval", async () => {
    const boundary = new Date("2026-09-30T23:59:59.000Z");
    const organization = await seedOrganization({
      slug: ORGS.cooldown,
      name: "M5 Cooldown",
      verified: true,
    });
    await grantMembership(publisherAccountId, organization.id, "publisher");
    await insertListing("cooldown", ORGS.cooldown);
    const service = new StaleListingReminderService(db, {
      config: reminderConfig,
    });

    // The job scans all publishers. Count this fixture's rows so other parallel suites becoming
    // stale at the simulated future dates cannot change the cooldown assertion.
    const fixtureRows = () =>
      db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.accountId, publisherAccountId),
            eq(notifications.kind, "stale_listing_reminder"),
            sql`${notifications.payload} ->> 'organizationId' = ${String(organization.id)}`,
          ),
        );
    const runForFixture = async (options: { now: Date }) => {
      const before = (await fixtureRows()).length;
      await service.runBatch(options);
      return { processed: (await fixtureRows()).length - before };
    };

    const first = await runForFixture({ now: boundary });
    expect(first.processed).toBe(1);
    const firstRow = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, publisherAccountId),
          eq(notifications.kind, "stale_listing_reminder"),
          eq(notifications.subjectId, publisherAccountId),
          sql`${notifications.payload} ->> 'organizationId' = ${String(organization.id)}`,
        ),
      )
      .orderBy(notifications.id)
      .limit(1);
    const firstId = firstRow[0]?.id;
    if (firstId === undefined) throw new Error("cooldown fixture did not create its first row");

    // Treat the first event as sent at the boundary. Crossing midnight by one second must not
    // create another event merely because the human-readable subject key changed UTC bucket.
    await db
      .update(notifications)
      .set({ emailDispatchedAt: boundary })
      .where(eq(notifications.id, firstId));
    const acrossBoundary = await runForFixture({
      now: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(acrossBoundary.processed).toBe(0);

    const beforeExact = await runForFixture({
      now: new Date(boundary.getTime() + 30 * 86_400_000 - 1),
    });
    expect(beforeExact.processed).toBe(0);
    const exact = await runForFixture({
      now: new Date(boundary.getTime() + 30 * 86_400_000),
    });
    expect(exact.processed).toBe(1);

    // A delayed provider completion moves the next interval to the actual dispatch timestamp.
    const secondRow = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, publisherAccountId),
          eq(notifications.kind, "stale_listing_reminder"),
          eq(notifications.subjectId, publisherAccountId),
          sql`${notifications.payload} ->> 'organizationId' = ${String(organization.id)}`,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(1);
    const secondId = secondRow[0]?.id;
    if (secondId === undefined) throw new Error("cooldown fixture did not create its second row");
    const delayedDispatch = new Date(boundary.getTime() + 31 * 86_400_000);
    await db
      .update(notifications)
      .set({ emailDispatchedAt: delayedDispatch })
      .where(eq(notifications.id, secondId));
    expect(
      (
        await runForFixture({
          now: new Date(delayedDispatch.getTime() + 30 * 86_400_000 - 1),
        })
      ).processed,
    ).toBe(0);
    expect(
      (
        await runForFixture({
          now: new Date(delayedDispatch.getTime() + 30 * 86_400_000),
        })
      ).processed,
    ).toBe(1);
  });

  it("advances past expired recipient groups and preserves members across limit-one pages", async () => {
    const expiredOrganization = await seedOrganization({
      slug: ORGS.pageExpired,
      name: "M5 Expired Page",
      verified: true,
    });
    const eligibleOrganization = await seedOrganization({
      slug: ORGS.pageEligible,
      name: "M5 Eligible Page",
      verified: true,
    });
    await grantMembership(publisherAccountId, expiredOrganization.id, "publisher");
    await grantMembership(publisherAccountId, eligibleOrganization.id, "publisher");
    await insertListing("page-expired", ORGS.pageExpired, {
      deadlines: [{ deadlineType: "fixed", date: "2026-08-01T00:00:00.000Z" }],
    });
    await insertListing("page-eligible", ORGS.pageEligible);

    const service = new StaleListingReminderService(db, {
      config: reminderConfig,
    });
    const report = await service.runBatch({ now: NOW, limit: 1 });
    expect(report).toMatchObject({ processed: 1, remaining: 0 });
    const eligibleRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, publisherAccountId),
          eq(notifications.kind, "stale_listing_reminder"),
          sql`${notifications.payload} ->> 'organizationId' = ${String(eligibleOrganization.id)}`,
        ),
      );
    expect(eligibleRows.length).toBeGreaterThan(0);

    const multiOrganization = await seedOrganization({
      slug: ORGS.multi,
      name: "M5 Multi Member",
      verified: true,
    });
    await grantMembership(publisherAccountId, multiOrganization.id, "publisher");
    await grantMembership(revokedAccountId, multiOrganization.id, "publisher");
    await insertListing("multi-member", ORGS.multi);
    const first = await service.runBatch({ now: NOW, limit: 1 });
    const second = await service.runBatch({ now: NOW, limit: 1 });
    expect(first.processed + second.processed).toBeGreaterThanOrEqual(2);
    const multiRows = await db
      .select({ accountId: notifications.accountId })
      .from(notifications)
      .where(
        and(
          eq(notifications.kind, "stale_listing_reminder"),
          inArray(notifications.accountId, [publisherAccountId, revokedAccountId]),
          sql`${notifications.payload} ->> 'organizationId' = ${String(multiOrganization.id)}`,
        ),
      );
    expect(multiRows.map((row) => row.accountId)).toEqual(
      expect.arrayContaining([publisherAccountId, revokedAccountId]),
    );
  });

  it("allows the next rolling cadence after a terminally exhausted reminder", async () => {
    const organization = await seedOrganization({
      slug: ORGS.terminal,
      name: "M5 Terminal Recovery",
      verified: true,
    });
    await grantMembership(publisherAccountId, organization.id, "publisher");
    await insertListing("terminal-recovery", ORGS.terminal);
    const service = new StaleListingReminderService(db, {
      config: reminderConfig,
    });
    const first = await service.runBatch({ now: NOW });
    expect(first.processed).toBe(1);
    const firstRow = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, publisherAccountId),
          eq(notifications.kind, "stale_listing_reminder"),
          sql`${notifications.payload} ->> 'organizationId' = ${String(organization.id)}`,
        ),
      )
      .limit(1);
    const firstId = firstRow[0]?.id;
    if (firstId === undefined) throw new Error("terminal fixture did not create its first row");

    // A terminal failure is no longer pending: the partial index excludes exhausted attempts, so
    // the next cadence can create a fresh audit event instead of being blocked forever.
    await db
      .update(notifications)
      .set({
        createdAt: NOW,
        emailFailedAt: NOW,
        payload: sql`jsonb_set(${notifications.payload}, '{emailDelivery}', '{"attempts":3,"failure":"transport_failure"}'::jsonb)`,
      })
      .where(eq(notifications.id, firstId));
    const recovered = await service.runBatch({
      now: new Date(NOW.getTime() + 30 * 86_400_000),
    });
    expect(recovered.processed).toBe(1);
  });

  it("serializes concurrent generators to one pending reminder per member and organization", async () => {
    const organization = await seedOrganization({
      slug: ORGS.concurrent,
      name: "M5 Concurrent",
      verified: true,
    });
    await grantMembership(publisherAccountId, organization.id, "publisher");
    await insertListing("concurrent", ORGS.concurrent);
    const makeService = () =>
      new StaleListingReminderService(db, {
        config: reminderConfig,
      });
    const reports = await Promise.all([
      makeService().runBatch({ now: NOW, limit: 1 }),
      makeService().runBatch({ now: NOW, limit: 1 }),
    ]);
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, publisherAccountId),
          eq(notifications.kind, "stale_listing_reminder"),
          sql`${notifications.payload} ->> 'organizationId' = ${String(organization.id)}`,
        ),
      );
    expect(rows).toHaveLength(1);
    expect(reports[0].processed + reports[1].processed).toBe(1);
  });

  it("only persists reminders from the scheduled registry and leaves sending to notification-dispatch", async () => {
    const organization = await seedOrganization({
      slug: ORGS.registry,
      name: "M5 Registry",
      verified: true,
    });
    await grantMembership(publisherAccountId, organization.id, "publisher");
    await insertListing("registry", ORGS.registry);
    const depthBefore = notificationDispatchQueue.queueDepth;
    const report = await runJob("stale-listing-reminders", {
      db,
      limit: 1,
      maxPasses: 1,
      now: NOW,
      lockConnectionString: config.databaseUrl,
    });
    expect(report.processed).toBe(1);
    expect(notificationDispatchQueue.queueDepth).toBe(depthBefore);
  });

  it("reports remaining recipients when the event limit is reached inside a short page", async () => {
    const rollback = new Error("rollback pagination fixtures");
    await expect(
      db.transaction(async (tx) => {
        const [template] = await tx
          .select()
          .from(opportunities)
          .where(eq(opportunities.publicId, "m5email:eligible"));
        if (!template) throw new Error("missing listing template");
        const { id: _templateId, ...listingTemplate } = template;
        // Uncommitted fixtures cannot be closed by another suite's staleness job. The historical
        // clock excludes all other suites' listings from this recipient walk.
        for (let index = 0; index < 5; index++) {
          const slug = `m5email-short-page-${index}`;
          const [organization] = await tx
            .insert(organizations)
            .values({
              slug,
              name: slug,
              verified: true,
            })
            .returning();
          if (!organization) throw new Error("missing pagination organization");
          await tx.insert(orgMemberships).values({
            accountId: publisherAccountId,
            organizationId: organization.id,
            role: "publisher",
          });
          await tx.insert(opportunities).values({
            ...listingTemplate,
            publicId: `m5email:short-page-${index}`,
            sourcePublisher: slug,
            lastSeenAt: new Date("1999-01-01T00:00:00.000Z"),
            nextDeadlineAt: null,
            deadlines:
              index === 0 ? [{ deadlineType: "fixed", date: "1999-12-01T00:00:00.000Z" }] : [],
          });
        }
        const service = new StaleListingReminderService(tx as unknown as DB, {
          config: reminderConfig,
        });
        const now = new Date("2000-01-01T00:00:00.000Z");
        // Page one has one expired group and two eligible groups. Page two is short (two groups),
        // but only its first group fits the remaining event budget. The last group still needs work.
        expect(await service.runBatch({ now, limit: 3 })).toMatchObject({
          processed: 3,
          remaining: 1,
        });
        expect(await service.runBatch({ now, limit: 3 })).toMatchObject({
          processed: 1,
          remaining: 0,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("records a publisher verification transition once and dispatches through the current member", async () => {
    const queueIds: number[] = [];
    const review = new ReviewService(db, {
      notificationQueue: { enqueue: (ids) => queueIds.push(...ids) },
    });
    await review.setVerified(reviewerAccountId, ORGS.verify, true);
    await review.setVerified(reviewerAccountId, ORGS.verify, true);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, reviewerAccountId),
          eq(notifications.kind, "publisher_verified"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(queueIds).toEqual([rows[0]?.id]);

    const email = new CaptureEmail();
    const dispatch = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl,
      accountId: reviewerAccountId,
    });
    const result = await dispatch.runBatch({ now: NOW, notificationIds: [rows[0]?.id ?? 0] });
    expect(result).toMatchObject({ processed: 1, details: { sent: 1 } });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toContain("M5 Verify");
  });

  it("retries a transient provider failure and records successful dispatch evidence", async () => {
    const email = new FailOnceEmail();
    const dispatch = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl,
      accountId: publisherAccountId,
    });
    const first = await dispatch.runBatch({ now: NOW, notificationIds: [staleReminderId] });
    expect(first).toMatchObject({ processed: 1, details: { failed: 1 } });
    const second = await dispatch.runBatch({
      now: new Date(NOW.getTime() + NOTIFICATION_EMAIL_RETRY_DELAY_MS),
      notificationIds: [staleReminderId],
    });
    expect(second).toMatchObject({ processed: 1, details: { sent: 1, retried: 1 } });
    expect(email.sent).toHaveLength(1);
    const delivered = await db
      .select({ dispatched: notifications.emailDispatchedAt, failed: notifications.emailFailedAt })
      .from(notifications)
      .where(eq(notifications.id, staleReminderId));
    expect(delivered[0]?.dispatched).not.toBeNull();
    expect(delivered[0]?.failed).toBeNull();
  });

  it("fails closed when a queued publisher loses membership before delivery", async () => {
    const rows = await db
      .insert(notifications)
      .values({
        accountId: revokedAccountId,
        kind: "publisher_verified",
        subjectKind: "email:publisher-verified",
        subjectId: publisherOrganizationId,
        payload: {
          organizationId: publisherOrganizationId,
          organizationSlug: ORGS.publisher,
          organizationName: "M5 Publisher",
        },
      })
      .returning({ id: notifications.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("verification notification fixture was not inserted");
    await db
      .delete(orgMemberships)
      .where(
        and(
          eq(orgMemberships.accountId, revokedAccountId),
          eq(orgMemberships.organizationId, publisherOrganizationId),
        ),
      );

    const email = new CaptureEmail();
    const dispatch = new NotificationDispatchService(db, {
      email,
      enabled: true,
      appBaseUrl,
      accountId: revokedAccountId,
    });
    const result = await dispatch.runBatch({ now: NOW, notificationIds: [id] });
    expect(result).toMatchObject({
      processed: 1,
      details: { failed: 1, recipientNotPublisher: 1 },
    });
    expect(email.sent).toHaveLength(0);
  });
});
