/** Sends durable notification emails; template functions only compose content. */
import { config } from "../../../config.js";
import type { NotificationRow } from "../../../db/schema.js";
import type { OutboundEmail, OutboundEmailPort, SendResult } from "../email/email.service.js";
import { composeDuplicateNotificationEmail } from "./duplicate-notification-email.js";
import { composeLifecycleNotificationEmail } from "./lifecycle-notification-email.js";
import { signUnsubscribeToken, unsubscribeUrl } from "./unsubscribe-token.js";

type EmailNotification = Pick<NotificationRow, "accountId" | "kind" | "payload" | "subjectKind">;

export interface UnsubscribeLinkConfig {
  /** The API origin that serves the unsubscribe route. */
  apiBaseUrl: string;
  secret: string;
}

export class NotificationEmailSender {
  constructor(
    private readonly email: OutboundEmailPort,
    private readonly appBaseUrl: string,
    private readonly unsubscribe: UnsubscribeLinkConfig = {
      apiBaseUrl: config.betterAuth.url,
      secret: config.betterAuth.secret,
    },
  ) {}

  send(notification: EmailNotification, recipientEmail: string): Promise<SendResult> {
    return this.email.send(
      composeNotificationEmail(notification, recipientEmail, this.appBaseUrl, this.unsubscribe),
    );
  }
}

/** Explicit event coverage: adding a notification kind requires choosing its email template. */
function composeNotificationEmail(
  notification: EmailNotification,
  recipientEmail: string,
  appBaseUrl: string,
  unsubscribe: UnsubscribeLinkConfig,
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
      return composeLifecycleNotificationEmail(notification, recipientEmail, appBaseUrl);
    case "stale_listing_reminder":
      return composeLifecycleNotificationEmail(
        notification,
        recipientEmail,
        appBaseUrl,
        unsubscribeUrl(
          unsubscribe.apiBaseUrl,
          signUnsubscribeToken(
            unsubscribe.secret,
            notification.accountId,
            "stale_listing_reminder",
          ),
        ),
      );
    default: {
      const unsupportedKind: never = kind;
      throw new Error(`unsupported notification email kind: ${unsupportedKind}`);
    }
  }
}
