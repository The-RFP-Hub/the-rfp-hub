/** Cursor job that delivers durable notifications without putting provider I/O on request paths. */
import { and, asc, count, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { accounts, authUser, notifications } from "../../../db/schema.js";
import { deliversEmail } from "../email/email-transport.js";
import {
  EmailService,
  type OutboundEmailPort,
  recipientFingerprint,
} from "../email/email.service.js";
import type { JobResult } from "../jobs/types.js";
import { DuplicateNotificationEmailComposer } from "./duplicate-notification-email.js";

export const NOTIFICATION_EMAIL_MAX_ATTEMPTS = 3;
export const NOTIFICATION_EMAIL_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type FailureReason = "recipient_unavailable" | "transport_failure" | "invalid_notification";

interface DeliveryState {
  attempts: number;
  failure: FailureReason;
}

export interface NotificationDispatchLogger {
  error(payload: Record<string, unknown>, message: string): void;
}

const consoleLogger: NotificationDispatchLogger = {
  error(payload, message) {
    console.error(message, JSON.stringify(payload));
  },
};

export interface NotificationDispatchOptions {
  email?: OutboundEmailPort;
  appBaseUrl?: string;
  /** Test seam. Environment-backed jobs derive this from `deliversEmail`. */
  enabled?: boolean;
  logger?: NotificationDispatchLogger;
  /** Integration-test scope; production leaves this unset and walks every account. */
  accountId?: number;
}

export class NotificationDispatchService {
  private readonly composer: DuplicateNotificationEmailComposer;
  private readonly enabled: boolean;
  private readonly logger: NotificationDispatchLogger;
  private readonly accountId: number | undefined;

  constructor(
    private readonly db: DB = defaultDb,
    options: NotificationDispatchOptions = {},
  ) {
    this.enabled = options.enabled ?? deliversEmail(config.email);
    this.logger = options.logger ?? consoleLogger;
    this.accountId = options.accountId;
    this.composer = new DuplicateNotificationEmailComposer(
      options.email ?? new EmailService(),
      options.appBaseUrl ?? config.appBaseUrl,
    );
  }

  async runBatch(options: { limit?: number; now?: Date } = {}): Promise<JobResult> {
    if (!this.enabled) {
      return {
        processed: 0,
        remaining: 0,
        skipped: "email delivery is not configured",
      };
    }

    const now = options.now ?? new Date();
    const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const retryBefore = new Date(now.getTime() - NOTIFICATION_EMAIL_RETRY_DELAY_MS);
    const candidates = await this.db
      .select({ notification: notifications, recipientEmail: authUser.email })
      .from(notifications)
      .innerJoin(accounts, eq(notifications.accountId, accounts.id))
      .leftJoin(authUser, eq(accounts.authUserId, authUser.id))
      .where(this.eligible(retryBefore))
      .orderBy(asc(notifications.id))
      .limit(limit);

    const details = {
      sent: 0,
      failed: 0,
      retried: 0,
      recipientUnavailable: 0,
      invalidNotification: 0,
    };

    for (const { notification, recipientEmail } of candidates) {
      const priorAttempts = deliveryAttempts(notification.payload);
      if (priorAttempts > 0) details.retried++;

      if (!recipientEmail) {
        await this.markFailure(
          notification.id,
          notification.payload,
          NOTIFICATION_EMAIL_MAX_ATTEMPTS,
          "recipient_unavailable",
          now,
        );
        details.failed++;
        details.recipientUnavailable++;
        continue;
      }

      let result: Awaited<ReturnType<DuplicateNotificationEmailComposer["send"]>>;
      try {
        result = await this.composer.send(notification, recipientEmail);
      } catch (error) {
        await this.markFailure(
          notification.id,
          notification.payload,
          NOTIFICATION_EMAIL_MAX_ATTEMPTS,
          "invalid_notification",
          now,
        );
        details.failed++;
        details.invalidNotification++;
        this.logger.error(
          {
            notificationId: notification.id,
            error: error instanceof Error ? error.name : typeof error,
            reason: error instanceof Error ? error.message : String(error),
          },
          "notification email could not be composed",
        );
        continue;
      }

      if (result.status === "failed") {
        await this.markFailure(
          notification.id,
          notification.payload,
          priorAttempts + 1,
          "transport_failure",
          now,
        );
        details.failed++;
        this.logger.error(
          {
            notificationId: notification.id,
            recipient: recipientFingerprint(recipientEmail),
            error: result.error,
            reason: result.reason,
          },
          "notification email could not be delivered",
        );
        continue;
      }

      await this.db
        .update(notifications)
        .set({
          emailDispatchedAt: now,
          emailFailedAt: null,
          payload: withoutDeliveryState(notification.payload),
        })
        .where(and(eq(notifications.id, notification.id), isNull(notifications.emailDispatchedAt)));
      details.sent++;
    }

    return {
      processed: candidates.length,
      remaining: await this.remainingCount(),
      details,
    };
  }

  private eligible(retryBefore: Date) {
    return and(
      this.accountId === undefined ? undefined : eq(notifications.accountId, this.accountId),
      isNull(notifications.emailDispatchedAt),
      or(
        isNull(notifications.emailFailedAt),
        and(
          isNotNull(notifications.emailFailedAt),
          lte(notifications.emailFailedAt, retryBefore),
          sql`${deliveryAttemptsSql()} < ${NOTIFICATION_EMAIL_MAX_ATTEMPTS}`,
        ),
      ),
    );
  }

  private async remainingCount(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          this.accountId === undefined ? undefined : eq(notifications.accountId, this.accountId),
          isNull(notifications.emailDispatchedAt),
          or(
            isNull(notifications.emailFailedAt),
            sql`${deliveryAttemptsSql()} < ${NOTIFICATION_EMAIL_MAX_ATTEMPTS}`,
          ),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  private async markFailure(
    notificationId: number,
    payload: Record<string, unknown>,
    attempts: number,
    failure: FailureReason,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(notifications)
      .set({
        emailFailedAt: now,
        payload: { ...withoutDeliveryState(payload), emailDelivery: { attempts, failure } },
      })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.emailDispatchedAt)));
  }
}

function deliveryAttemptsSql() {
  return sql<number>`coalesce((${notifications.payload} -> 'emailDelivery' ->> 'attempts')::integer, 0)`;
}

function deliveryAttempts(payload: Record<string, unknown>): number {
  const raw = payload.emailDelivery;
  if (typeof raw !== "object" || raw === null) return 0;
  const attempts = (raw as Partial<DeliveryState>).attempts;
  return typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function withoutDeliveryState(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "emailDelivery"));
}
