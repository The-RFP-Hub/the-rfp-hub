/** Routes every durable notification kind to its domain-owned text composer. */
import type { NotificationRow } from "../../../db/schema.js";
import type { OutboundEmailPort, SendResult } from "../email/email.service.js";
import { DuplicateNotificationEmailComposer } from "./duplicate-notification-email.js";
import { LifecycleNotificationEmailComposer } from "./lifecycle-notification-email.js";

export class NotificationEmailComposer {
  private readonly duplicate: DuplicateNotificationEmailComposer;
  private readonly lifecycle: LifecycleNotificationEmailComposer;

  constructor(email: OutboundEmailPort, appBaseUrl: string) {
    this.duplicate = new DuplicateNotificationEmailComposer(email, appBaseUrl);
    this.lifecycle = new LifecycleNotificationEmailComposer(email, appBaseUrl);
  }

  send(
    notification: Pick<NotificationRow, "kind" | "payload" | "subjectKind">,
    recipientEmail: string,
  ): Promise<SendResult> {
    if (notification.subjectKind === "duplicate") {
      return this.duplicate.send(notification, recipientEmail);
    }
    return this.lifecycle.send(notification, recipientEmail);
  }
}
