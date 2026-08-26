"use client";

/** Account-scoped duplicate events, rendered from structured payloads rather than stored prose. */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import {
  ActionNote,
  type ActionNoteValue,
  EmptyState,
  ResourceView,
  actionErrorNote,
} from "@/components/states";
import { formatInstant, formatSimilarity } from "@/lib/format";
import { announceNotificationsChanged } from "@/lib/notification-events";
import { ROUTE_GATE_COPY, notificationActionLabel, notificationCopy } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { Notification } from "@/lib/types";
import Link from "next/link";
import { useCallback, useState } from "react";

export default function NotificationsPage() {
  return (
    <RequireSession gate={ROUTE_GATE_COPY.notifications}>{() => <Notifications />}</RequireSession>
  );
}

function Notifications() {
  const api = useApi();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [note, setNote] = useState<ActionNoteValue | null>(null);
  const load = useCallback(() => api.me.notifications({ page, limit: 20 }), [api, page]);
  const { state, reload } = useResource(load);

  const markRead = async (notification: Notification) => {
    setBusy(notification.id);
    setNote(null);
    try {
      await api.me.readNotification(notification.id);
      reload();
      announceNotificationsChanged();
    } catch (error) {
      setNote(actionErrorNote(error, "The notification could not be marked as read."));
    } finally {
      setBusy(null);
    }
  };

  const markAllRead = async () => {
    setBusy("all");
    setNote(null);
    try {
      const result = await api.me.readAllNotifications();
      setNote({
        kind: "ok",
        message:
          result.markedRead === 0
            ? "Everything was already read."
            : `${result.markedRead} notification${result.markedRead === 1 ? "" : "s"} marked as read.`,
      });
      reload();
      announceNotificationsChanged();
    } catch (error) {
      setNote(actionErrorNote(error, "The notifications could not be marked as read."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="row-between">
        <div>
          <h1>Notifications</h1>
          <p className="muted footnote">
            Possible matches and reviewer actions involving listings you own. Similarity is a
            likeness signal, never a verdict.
          </p>
        </div>
        {state.status === "ready" && state.data.unreadCount > 0 ? (
          <button type="button" disabled={busy !== null} onClick={() => void markAllRead()}>
            {busy === "all" ? "Marking all…" : "Mark all as read"}
          </button>
        ) : null}
      </div>

      <ActionNote note={note} />

      <ResourceView resource={state} what="your notifications" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="No notifications yet."
              detail="When a listing looks similar to another submission, or a reviewer acts on that possible match, the update will appear here."
              action={<Link href="/listings">Your listings</Link>}
            />
          ) : (
            <>
              <p className="notification-count muted">
                {list.unreadCount} unread · {list.total} total · page {list.page} of{" "}
                {list.totalPages}
              </p>
              <ol className="notification-list">
                {list.items.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    busy={busy === notification.id}
                    onMarkRead={markRead}
                  />
                ))}
              </ol>
              {list.totalPages > 1 ? (
                <nav className="pagination" aria-label="Notification pages">
                  <button
                    type="button"
                    disabled={list.page <= 1 || busy !== null}
                    onClick={() => setPage(list.page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {list.page} of {list.totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={list.page >= list.totalPages || busy !== null}
                    onClick={() => setPage(list.page + 1)}
                  >
                    Next
                  </button>
                </nav>
              ) : null}
            </>
          )
        }
      </ResourceView>
    </section>
  );
}

function NotificationItem({
  notification,
  busy,
  onMarkRead,
}: {
  notification: Notification;
  busy: boolean;
  onMarkRead: (notification: Notification) => Promise<void>;
}) {
  const copy = notificationCopy(notification.kind);
  const other = notification.payload.otherListing;
  const unread = notification.readAt === null;

  return (
    <li className="notification-item" data-unread={unread}>
      <article aria-labelledby={`notification-${notification.id}`}>
        <div className="notification-head">
          <div className="notification-heading">
            <span className="notification-state">{unread ? "Unread" : "Read"}</span>
            <h2 className="notification-title" id={`notification-${notification.id}`}>
              {copy.title}
            </h2>
          </div>
          <time className="muted" dateTime={notification.createdAt}>
            {formatInstant(notification.createdAt)}
          </time>
        </div>

        <p className="notification-message">
          <strong>
            <UntrustedText value={notification.payload.yourListing.title} />
          </strong>
          {other ? (
            <>
              {copy.withOther}
              <strong>
                <UntrustedText value={other.title} />
              </strong>
              .
            </>
          ) : (
            copy.withoutOther
          )}{" "}
          <span className="muted">{copy.detail}</span>
        </p>

        <div className="notification-meta muted">
          Match <code>#{notification.payload.pairId}</code> · similarity{" "}
          {formatSimilarity(notification.payload.similarity)}
        </div>

        <div className="notification-actions">
          <Link href={notification.payload.link}>
            {notificationActionLabel(notification.payload.action)}
          </Link>
          {unread ? (
            <button type="button" disabled={busy} onClick={() => void onMarkRead(notification)}>
              {busy ? "Marking…" : "Mark as read"}
            </button>
          ) : null}
        </div>
      </article>
    </li>
  );
}
