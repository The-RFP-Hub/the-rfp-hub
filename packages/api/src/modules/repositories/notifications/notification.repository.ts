import { randomUUID } from "node:crypto";
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
  /**
   * The same cool-down floor `selectForDispatch` uses, and it must be the same VALUE: this count is
   * the job's `remaining`, which the runner reads as "there is more of this to do".
   */
  retryBefore: Date;
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

  /**
   * Claim rows for exactly one dispatcher, in one statement, BEFORE anything is sent.
   *
   * This used to be a bare SELECT, which left the read, the provider call and the stamp in three
   * separate round trips. Two dispatchers — the in-process queue and the nightly job, or two job
   * containers — could read the same row inside that window and both mail it. Three things close
   * that, and all three have to be in this one statement:
   *
   * 1. **The claim IS the write.** `FOR UPDATE SKIP LOCKED` on the inner select serialises it:
   *    whichever transaction reaches the row first owns it, and the other skips past rather than
   *    blocking and then acting on state it has already lost.
   * 2. **Pre-stamping `email_failed_at` hides the row for the retry floor.** The row lock lasts
   *    only until this statement commits — far less than a provider round trip — so the lock alone
   *    would not cover the send. A future `email_failed_at` fails the eligibility predicate for
   *    every other reader until the floor elapses, which is the window the send has to finish in.
   *    Success clears the column exactly as before, so a delivered notification carries no
   *    delivery state.
   * 3. **The attempt is counted here, not at failure time.** That is what bounds a crash: a
   *    dispatcher lost between the lease and the stamp BURNS one of its three attempts instead of
   *    leaving a row that is retried forever. The payload says `in_flight` precisely because
   *    nothing observed how that attempt ended — the caller overwrites it with the real outcome.
   * 4. **The lease carries an owner, not only a deadline.** A time-based lease alone is a promise
   *    the sender cannot keep: a batch that sends serially, or one provider call that hangs, can
   *    outlive the retry floor, and then the stamp expires while this dispatcher is still holding
   *    the row in memory. So the lease mints a `leaseToken`, and every later write about this row —
   *    the renewal before each send, the success stamp, the failure stamp — is conditional on it.
   *    An expired owner does not discover its loss by being lucky; it discovers it because its
   *    UPDATE matches no rows. `randomUUID` is a fresh token per lease, so a re-lease always
   *    revokes the previous holder.
   *
   * No new column is needed for any of it: `email_failed_at` plus `payload.emailDelivery` already
   * carry the deadline, the attempt count and now the owner, so there is no migration behind this
   * change.
   */
  async selectForDispatch(selection: NotificationDispatchSelection): Promise<NotificationRow[]> {
    const claimable = this.exec
      .select({ id: notifications.id })
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
      .limit(selection.limit)
      .for("update", { skipLocked: true });

    const leaseToken = randomUUID();
    const leased = await this.exec
      .update(notifications)
      .set({
        emailFailedAt: sql`now()`,
        payload: sql`jsonb_set(${notifications.payload}, '{emailDelivery}', jsonb_build_object('attempts', ${deliveryAttemptsSql()} + 1, 'failure', 'in_flight'::text, 'leaseToken', ${leaseToken}::text))`,
      })
      .where(inArray(notifications.id, sql`(${claimable})`))
      .returning();

    // `RETURNING` has no order of its own; the caller's contract is still ascending id.
    return leased.sort((left, right) => left.id - right.id);
  }

  /**
   * How many rows `selectForDispatch` would still pick up — the SAME predicate, deliberately.
   *
   * It used to drop the `retryBefore` arm, and the two clauses disagreeing is not a cosmetic
   * difference: a row that failed a minute ago is inside its five-minute cool-down, so the
   * selection correctly will not take it, while this count did — and `remaining` is what the
   * runner reads as "go round again". The next pass then selects nothing, and only the
   * `processed > 0` half of the loop condition stopped it. A count that answers a different
   * question from the selection is a count nobody can act on.
   */
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
            and(
              isNotNull(notifications.emailFailedAt),
              lte(notifications.emailFailedAt, selection.retryBefore),
              sql`${deliveryAttemptsSql()} < ${selection.maxAttempts}`,
            ),
          ),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * Re-stamp the deadline for the holder of `leaseToken`, and say whether it is still the holder.
   *
   * Called immediately before each send, which is what turns a lease that can EXPIRE into one that
   * can be LOST SAFELY. `false` means somebody else re-leased this row while this dispatcher was
   * working through the rest of its batch: the correct response is to send nothing and write
   * nothing, because the new owner is already responsible for the mail.
   */
  async renewLease(notificationId: number, leaseToken: string): Promise<boolean> {
    const renewed = await this.exec
      .update(notifications)
      .set({ emailFailedAt: sql`now()` })
      .where(
        and(
          eq(notifications.id, notificationId),
          isNull(notifications.emailDispatchedAt),
          eq(leaseTokenSql(), leaseToken),
        ),
      )
      .returning({ id: notifications.id });
    return renewed.length === 1;
  }

  /**
   * Both stamps are conditional on the lease token for the same reason the renewal is: a dispatcher
   * that lost the row must not be able to overwrite the outcome of the send that replaced its own.
   * A stale stamp is a silent no-op, which is exactly what it should be — it describes an attempt
   * nobody is entitled to record.
   */
  async markDispatched(
    notificationId: number,
    payload: Record<string, unknown>,
    completedAt: Date,
    leaseToken: string,
  ): Promise<void> {
    await this.exec
      .update(notifications)
      .set({ emailDispatchedAt: completedAt, emailFailedAt: null, payload })
      .where(
        and(
          eq(notifications.id, notificationId),
          isNull(notifications.emailDispatchedAt),
          eq(leaseTokenSql(), leaseToken),
        ),
      );
  }

  async markDispatchFailure(
    notificationId: number,
    payload: Record<string, unknown>,
    failedAt: Date,
    leaseToken: string,
  ): Promise<void> {
    await this.exec
      .update(notifications)
      .set({ emailFailedAt: failedAt, payload })
      .where(
        and(
          eq(notifications.id, notificationId),
          isNull(notifications.emailDispatchedAt),
          eq(leaseTokenSql(), leaseToken),
        ),
      );
  }
}

function leaseTokenSql() {
  return sql<string>`(${notifications.payload} -> 'emailDelivery' ->> 'leaseToken')`;
}

function deliveryAttemptsSql() {
  return sql<number>`coalesce((${notifications.payload} -> 'emailDelivery' ->> 'attempts')::integer, 0)`;
}
