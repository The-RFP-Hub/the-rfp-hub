/** Sends durable notification emails; template functions only compose content. */
import type { NotificationRow } from "../../../db/schema.js";
import type { OutboundEmail, OutboundEmailPort, SendResult } from "../email/email.service.js";
import { composeDuplicateNotificationEmail } from "./duplicate-notification-email.js";
import { composeLifecycleNotificationEmail } from "./lifecycle-notification-email.js";

type EmailNotification = Pick<NotificationRow, "kind" | "payload" | "subjectKind">;

export class NotificationEmailSender {
  constructor(
    private readonly email: OutboundEmailPort,
    private readonly appBaseUrl: string,
  ) {}

  send(notification: EmailNotification, recipientEmail: string): Promise<SendResult> {
    return this.email.send(composeNotificationEmail(notification, recipientEmail, this.appBaseUrl));
  }
}

/** Explicit event coverage: adding a notification kind requires choosing its email template. */
function composeNotificationEmail(
  notification: EmailNotification,
  recipientEmail: string,
  appBaseUrl: string,
): OutboundEmail {
  const kind = notification.kind;
  switch (kind) {
    case "duplicate_suspected":
    case "duplicate_confirmed":
    case "duplicate_dismissed":
    case "duplicate_merged_away":
    case "duplicate_absorbed":
    case "duplicate_reopened":
      return composeDuplicateNotificationEmail(notification, recipientEmail, appBaseUrl);
    case "welcome":
    case "publisher_verified":
    case "stale_listing_reminder":
      return composeLifecycleNotificationEmail(notification, recipientEmail, appBaseUrl);
    default: {
      const unsupportedKind: never = kind;
      throw new Error(`unsupported notification email kind: ${unsupportedKind}`);
    }
  }
}
