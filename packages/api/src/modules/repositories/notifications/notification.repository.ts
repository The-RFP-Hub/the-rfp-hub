import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { type NotificationRow, notifications } from "../../../db/schema.js";

export interface NotificationInsert {
  accountId: number;
  kind: NotificationRow["kind"];
  subjectKind: string;
  subjectId: number;
  payload: Record<string, unknown>;
}

export interface NotificationInboxPage {
  rows: NotificationRow[];
  total: number;
  unread: number;
}

export interface NotificationDispatchSelection {
  accountId?: number;
  notificationIds?: number[];
  retryBefore: Date;
  maxAttempts: number;
  limit: number;
}

export interface NotificationRemainingSelection {
  accountId?: number;
  notificationIds?: number[];
  maxAttempts: number;
}

export class NotificationRepository {
  constructor(private readonly exec: DbLike) {}

  async recordDuplicate(values: NotificationInsert[]): Promise<number[]> {
    if (values.length === 0) return [];
    const inserted = await this.exec
      .insert(notifications)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return inserted.map(({ id }) => id);
  }

  async listForAccount(
    accountId: number,
    unread: boolean | undefined,
    limit: number,
    offset: number,
  ): Promise<NotificationInboxPage> {
    const where = and(
      eq(notifications.accountId, accountId),
      unread === undefined
        ? undefined
        : unread
          ? isNull(notifications.readAt)
          : isNotNull(notifications.readAt),
    );
    const unreadWhere = and(eq(notifications.accountId, accountId), isNull(notifications.readAt));
    const [rows, counted, unreadRows] = await Promise.all([
      this.exec
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
        .offset(offset),
      this.exec.select({ value: count() }).from(notifications).where(where),
      this.exec.select({ value: count() }).from(notifications).where(unreadWhere),
    ]);
    return {
      rows,
      total: counted[0]?.value ?? 0,
      unread: unreadRows[0]?.value ?? 0,
    };
  }

  async markRead(accountId: number, notificationId: number): Promise<NotificationRow | undefined> {
    const rows = await this.exec
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId)))
      .returning();
    return rows[0];
  }

  async markAllRead(accountId: number): Promise<number> {
    const rows = await this.exec
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  async selectForDispatch(selection: NotificationDispatchSelection): Promise<NotificationRow[]> {
    return this.exec
      .select()
      .from(notifications)
      .where(
        and(
          selection.accountId === undefined
            ? undefined
            : eq(notifications.accountId, selection.accountId),
          selection.notificationIds === undefined
            ? undefined
            : inArray(notifications.id, selection.notificationIds),
          isNull(notifications.emailDispatchedAt),
          or(
            isNull(notifications.emailFailedAt),
            and(
              isNotNull(notifications.emailFailedAt),
              lte(notifications.emailFailedAt, selection.retryBefore),
              sql`${deliveryAttemptsSql()} < ${selection.maxAttempts}`,
            ),
          ),
        ),
      )
      .orderBy(asc(notifications.id))
      .limit(selection.limit);
  }

  async remainingDispatchCount(selection: NotificationRemainingSelection): Promise<number> {
    const rows = await this.exec
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          selection.accountId === undefined
            ? undefined
            : eq(notifications.accountId, selection.accountId),
          selection.notificationIds === undefined
            ? undefined
            : inArray(notifications.id, selection.notificationIds),
          isNull(notifications.emailDispatchedAt),
          or(
            isNull(notifications.emailFailedAt),
            sql`${deliveryAttemptsSql()} < ${selection.maxAttempts}`,
          ),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async markDispatched(
    notificationId: number,
    payload: Record<string, unknown>,
    completedAt: Date,
  ): Promise<void> {
    await this.exec
      .update(notifications)
      .set({ emailDispatchedAt: completedAt, emailFailedAt: null, payload })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.emailDispatchedAt)));
  }

  async markDispatchFailure(
    notificationId: number,
    payload: Record<string, unknown>,
    failedAt: Date,
  ): Promise<void> {
    await this.exec
      .update(notifications)
      .set({ emailFailedAt: failedAt, payload })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.emailDispatchedAt)));
  }
}

function deliveryAttemptsSql() {
  return sql<number>`coalesce((${notifications.payload} -> 'emailDelivery' ->> 'attempts')::integer, 0)`;
}
