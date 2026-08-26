/** A local mutation hint for the persistent chrome; it triggers a fetch and carries no data. */
export const NOTIFICATIONS_CHANGED_EVENT = "rfphub:notifications-changed";

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
