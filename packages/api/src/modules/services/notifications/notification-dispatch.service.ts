/** Shared durable notification dispatcher for immediate attempts and the nightly cursor job. */
import { config } from "../../../config.js";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type Repositories, repositories } from "../../repositories/index.js";
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

/**
 * `in_flight` is written by the lease, never by this service: it is the state of an attempt whose
 * outcome nobody has observed yet, and every path below replaces it with a real one.
 */
type FailureReason =
  | "recipient_unavailable"
  | "transport_failure"
  | "invalid_notification"
  | "in_flight";

interface DeliveryState {
  attempts: number;
  failure: FailureReason;
  /** Present only while a dispatcher holds the row. Written by the lease, cleared by success. */
  leaseToken?: string;
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
  /** Per-attempt completion clock. Tests can advance it without waiting in real time. */
  clock?: () => Date;
}

export interface NotificationDispatchBatchOptions {
  limit?: number;
  /** Batch-start clock used to decide which retry rows are eligible. */
  now?: Date;
  /** Immediate-dispatch scope. The nightly sweep leaves this unset. */
  notificationIds?: readonly number[];
}

export class NotificationDispatchService {
  private readonly repos: Repositories;
  private readonly composer: DuplicateNotificationEmailComposer;
  private readonly enabled: boolean;
  private readonly logger: NotificationDispatchLogger;
  private readonly accountId: number | undefined;
  private readonly clock: (() => Date) | undefined;

  constructor(
    private readonly db: DB = defaultDb,
    options: NotificationDispatchOptions = {},
  ) {
    this.repos = repositories(db);
    this.enabled = options.enabled ?? deliversEmail(config.email);
    this.logger = options.logger ?? consoleLogger;
    this.accountId = options.accountId;
    this.clock = options.clock;
    this.composer = new DuplicateNotificationEmailComposer(
      options.email ?? new EmailService(),
      options.appBaseUrl ?? config.appBaseUrl,
    );
  }

  async runBatch(options: NotificationDispatchBatchOptions = {}): Promise<JobResult> {
    if (!this.enabled) {
      return {
        processed: 0,
        remaining: 0,
        skipped: "email delivery is not configured",
      };
    }

    const now = options.now ?? this.clock?.() ?? new Date();
    const completedAt = () => this.clock?.() ?? (options.now === undefined ? new Date() : now);
    const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const retryBefore = new Date(now.getTime() - NOTIFICATION_EMAIL_RETRY_DELAY_MS);
    const notificationIds = normalizedIds(options.notificationIds);
    if (notificationIds !== undefined && notificationIds.length === 0) {
      return { processed: 0, remaining: 0 };
    }
    // Leased, not merely read: every row that comes back is already stamped in flight with its
    // attempt counted, so no other dispatcher can pick it up while this loop is talking to the
    // provider. See `NotificationRepository.selectForDispatch`.
    const candidates = await this.repos.notifications.selectForDispatch({
      accountId: this.accountId,
      notificationIds,
      retryBefore,
      maxAttempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
      limit,
    });
    const recipients = new Map(
      (
        await this.repos.accounts.notificationRecipients([
          ...new Set(candidates.map((notification) => notification.accountId)),
        ])
      ).map(({ accountId, email }) => [accountId, email]),
    );

    const details = {
      sent: 0,
      failed: 0,
      retried: 0,
      recipientUnavailable: 0,
      invalidNotification: 0,
      /** Rows this run leased and then lost to another dispatcher before it could send them. */
      leaseLost: 0,
    };

    for (const notification of candidates) {
      // Our proof of ownership for this row, minted by the lease. Every write below is conditional
      // on it, and its absence means the row was never ours to send.
      const leaseToken = deliveryLeaseToken(notification.payload);
      if (leaseToken === undefined) {
        details.leaseLost++;
        continue;
      }
      const recipientEmail = recipients.get(notification.accountId) ?? null;
      // The lease already incremented this, so it counts THIS attempt, not the ones before it —
      // hence `> 1` for "we have been here before" and no `+ 1` at the failure stamp below.
      const attempts = deliveryAttempts(notification.payload);
      if (attempts > 1) details.retried++;

      if (!recipientEmail) {
        const attemptCompletedAt = completedAt();
        await this.markFailure(
          notification.id,
          notification.payload,
          NOTIFICATION_EMAIL_MAX_ATTEMPTS,
          "recipient_unavailable",
          attemptCompletedAt,
          leaseToken,
        );
        details.failed++;
        details.recipientUnavailable++;
        continue;
      }

      /*
       * Renew the lease IMMEDIATELY BEFORE the send, and treat a refusal as a decision.
       *
       * The rows were all leased at the top of the batch, but they are sent one at a time: with a
       * long enough batch, or one provider call that hangs, the deadline stamped back then can
       * expire while this loop is still walking. A time-based lease has no way to notice — it
       * would send anyway, into a row a second dispatcher has already re-leased and mailed. So the
       * deadline is pushed forward here, conditionally on the token, and losing that race is
       * reported rather than survived: send nothing, write nothing, leave the row to its new owner.
       */
      if (!(await this.repos.notifications.renewLease(notification.id, leaseToken))) {
        details.leaseLost++;
        this.logger.error(
          { notificationId: notification.id, attempts },
          "notification email lease expired before its send and was taken by another dispatcher",
        );
        continue;
      }

      let result: Awaited<ReturnType<DuplicateNotificationEmailComposer["send"]>>;
      try {
        result = await this.composer.send(notification, recipientEmail);
      } catch (error) {
        const attemptCompletedAt = completedAt();
        await this.markFailure(
          notification.id,
          notification.payload,
          NOTIFICATION_EMAIL_MAX_ATTEMPTS,
          "invalid_notification",
          attemptCompletedAt,
          leaseToken,
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
        const attemptCompletedAt = completedAt();
        await this.markFailure(
          notification.id,
          notification.payload,
          attempts,
          "transport_failure",
          attemptCompletedAt,
          leaseToken,
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

      await this.repos.notifications.markDispatched(
        notification.id,
        withoutDeliveryState(notification.payload),
        completedAt(),
        leaseToken,
      );
      details.sent++;
    }

    return {
      processed: candidates.length,
      remaining: await this.remainingCount(notificationIds),
      details,
    };
  }

  private async remainingCount(notificationIds?: number[]): Promise<number> {
    return this.repos.notifications.remainingDispatchCount({
      accountId: this.accountId,
      notificationIds,
      maxAttempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
    });
  }

  private async markFailure(
    notificationId: number,
    payload: Record<string, unknown>,
    attempts: number,
    failure: FailureReason,
    now: Date,
    leaseToken: string,
  ): Promise<void> {
    // The stored state drops the token: the attempt is over, and the row is nobody's until the
    // next lease mints a new one.
    await this.repos.notifications.markDispatchFailure(
      notificationId,
      { ...withoutDeliveryState(payload), emailDelivery: { attempts, failure } },
      now,
      leaseToken,
    );
  }
}

function normalizedIds(ids: readonly number[] | undefined): number[] | undefined {
  if (ids === undefined) return undefined;
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

function deliveryAttempts(payload: Record<string, unknown>): number {
  const raw = payload.emailDelivery;
  if (typeof raw !== "object" || raw === null) return 0;
  const attempts = (raw as Partial<DeliveryState>).attempts;
  return typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function deliveryLeaseToken(payload: Record<string, unknown>): string | undefined {
  const raw = payload.emailDelivery;
  if (typeof raw !== "object" || raw === null) return undefined;
  const token = (raw as Partial<DeliveryState>).leaseToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function withoutDeliveryState(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "emailDelivery"));
}
