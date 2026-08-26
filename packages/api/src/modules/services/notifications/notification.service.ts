/**
 * Durable in-app notifications, written with the transaction that produced the event.
 *
 * Duplicate payloads contain facts only. Human-facing sentences and action labels belong to the
 * frontend presentation vocabulary, where copy can change without rewriting stored rows. A
 * counterpart is named only while it is approved and listed at emission time; otherwise even an
 * owner-visible pending row is coarsened to an unnamed "other submission" by presentation.
 */
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { type DB, type DbLike, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityDuplicateRow,
  type OpportunityRow,
  type notificationKind,
  notifications,
} from "../../../db/schema.js";
import type {
  DuplicateNotificationPayloadView,
  NotificationListView,
  NotificationReadAllView,
  NotificationView,
} from "../../shared/api-views.js";
import { notFound } from "../../shared/http-error.js";
import { paginate } from "../../shared/pagination.js";
import { opportunityOwnerAccountIds } from "../opportunities/opportunity-ownership.js";

export type NotificationKind = (typeof notificationKind.enumValues)[number];
export type DuplicateNotificationAction = "review_match" | "view_match" | "view_survivor";

export interface DuplicateNotificationPayload {
  pairId: number;
  similarity: number | null;
  yourListing: { id: string; title: string };
  otherListing?: { id: string; title: string };
  action: DuplicateNotificationAction;
  link: string;
  decidedBy: "reviewer" | null;
}

export interface DuplicateNotificationEvent {
  kind: NotificationKind;
  /** Owners of this side receive the event; duplicate account ids are collapsed before insert. */
  ownerOpportunityId: number;
}

export interface RecordDuplicateNotificationsInput {
  pair: OpportunityDuplicateRow;
  left: OpportunityRow;
  right: OpportunityRow;
  events: DuplicateNotificationEvent[];
  decidedBy?: "reviewer";
}

export interface NotificationListQuery {
  unread?: boolean;
  page?: number;
  limit?: number;
}

export class NotificationService {
  constructor(private readonly db: DB = defaultDb) {}

  /**
   * Record one or more owner-side views of a pair event.
   *
   * Takes the caller's handle rather than reaching for the pool, exactly like AuditService.record:
   * a rolled-back pair mutation cannot leave a notification claiming it happened. The unique
   * constraint remains the backstop, while the map makes recipient deduplication explicit.
   */
  async recordDuplicate(tx: DbLike, input: RecordDuplicateNotificationsInput): Promise<void> {
    const sides = new Map([
      [input.left.id, input.left],
      [input.right.id, input.right],
    ]);
    const recipients = new Map<
      string,
      { accountId: number; kind: NotificationKind; yours: OpportunityRow; other: OpportunityRow }
    >();

    for (const event of input.events) {
      const yours = sides.get(event.ownerOpportunityId);
      if (!yours) {
        throw new Error(
          `notification event side ${event.ownerOpportunityId} is not in duplicate pair ${input.pair.id}`,
        );
      }
      const other = yours.id === input.left.id ? input.right : input.left;
      for (const accountId of await opportunityOwnerAccountIds(tx, yours)) {
        const key = `${accountId}:${event.kind}`;
        if (!recipients.has(key))
          recipients.set(key, { accountId, kind: event.kind, yours, other });
      }
    }

    if (recipients.size === 0) return;
    await tx
      .insert(notifications)
      .values(
        [...recipients.values()].map(({ accountId, kind, yours, other }) => ({
          accountId,
          kind,
          subjectKind: "duplicate",
          subjectId: input.pair.id,
          payload: duplicatePayload(input, kind, yours, other) as unknown as Record<
            string,
            unknown
          >,
        })),
      )
      .onConflictDoNothing();
  }

  /** Account-scoped inbox, newest first, plus a count the chrome can render without a second API. */
  async listForAccount(
    accountId: number,
    query: NotificationListQuery = {},
  ): Promise<NotificationListView> {
    const { page, limit, offset } = paginate(query.page ?? 1, query.limit ?? 20);
    const where = and(
      eq(notifications.accountId, accountId),
      query.unread === true ? isNull(notifications.readAt) : undefined,
    );
    const unreadWhere = and(eq(notifications.accountId, accountId), isNull(notifications.readAt));
    const [rows, counted, unread] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(notifications).where(where),
      this.db.select({ value: count() }).from(notifications).where(unreadWhere),
    ]);
    const total = counted[0]?.value ?? 0;
    return {
      items: rows.map(toNotificationView),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      unreadCount: unread[0]?.value ?? 0,
    };
  }

  /** Idempotently mark one owned notification read without moving its original read timestamp. */
  async markRead(accountId: number, notificationId: number): Promise<NotificationView> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId)))
      .returning();
    const row = rows[0];
    if (!row) throw notFound(`no notification ${notificationId} of yours.`);
    return toNotificationView(row);
  }

  /** Settle every currently unread row for this account in one statement. */
  async markAllRead(accountId: number): Promise<NotificationReadAllView> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { markedRead: rows.length, unreadCount: 0 };
  }
}

function toNotificationView(row: typeof notifications.$inferSelect): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: "duplicate",
    subjectId: row.subjectId,
    payload: row.payload as unknown as DuplicateNotificationPayloadView,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

function duplicatePayload(
  input: RecordDuplicateNotificationsInput,
  kind: NotificationKind,
  yours: OpportunityRow,
  other: OpportunityRow,
): DuplicateNotificationPayload {
  const publicOther = other.reviewStatus === "approved" && other.isListed;
  const viewSurvivor = kind === "duplicate_merged_away" && publicOther;
  const action: DuplicateNotificationAction = viewSurvivor
    ? "view_survivor"
    : kind === "duplicate_suspected" || kind === "duplicate_reopened"
      ? "review_match"
      : "view_match";

  return {
    pairId: input.pair.id,
    similarity: input.pair.similarity === null ? null : Number(input.pair.similarity),
    yourListing: { id: yours.publicId, title: yours.title },
    ...(publicOther ? { otherListing: { id: other.publicId, title: other.title } } : {}),
    action,
    link: viewSurvivor ? `/opportunities/${encodeURIComponent(other.publicId)}` : "/duplicates",
    decidedBy: input.decidedBy ?? null,
  };
}
