/** Duplicate-domain email copy and the adapter that sends it through the central email port. */
import { config } from "../../../config.js";
import type { NotificationRow } from "../../../db/schema.js";
import type { OutboundEmail, OutboundEmailPort, SendResult } from "../email/email.service.js";
import type { DuplicateNotificationPayload, NotificationKind } from "./notification.service.js";

type DuplicateNotification = Pick<NotificationRow, "kind" | "payload" | "subjectKind">;

const SUBJECTS: Record<NotificationKind, string> = {
  duplicate_suspected: "A possible duplicate was found",
  duplicate_confirmed: "A possible duplicate was reviewed",
  duplicate_dismissed: "A possible duplicate was dismissed",
  duplicate_merged_away: "Your listing was merged after duplicate review",
  duplicate_absorbed: "Another submission was merged into your listing",
  duplicate_reopened: "A possible duplicate was reopened for review",
};

/**
 * Build text from the already privacy-filtered notification payload.
 *
 * The composer never re-resolves the pair. If emission omitted `otherListing`, email omits it too;
 * this is what keeps a later change in database visibility from widening an older notification.
 */
export function composeDuplicateNotificationEmail(
  notification: DuplicateNotification,
  recipientEmail: string,
  appBaseUrl = config.appBaseUrl,
): OutboundEmail {
  if (notification.subjectKind !== "duplicate") {
    throw new Error(
      `notification subject ${JSON.stringify(notification.subjectKind)} is not a duplicate`,
    );
  }
  const payload = duplicatePayload(notification.payload);
  const actor = payload.decidedBy === "reviewer" ? "A reviewer" : "The duplicate review workflow";
  const event = eventCopy(notification.kind, actor);
  const counterpart = payload.otherListing
    ? `The possible counterpart named in your notification is “${payload.otherListing.title}” (${payload.otherListing.id}).`
    : "The possible counterpart is not public, so this email does not name it.";
  const destination = new URL(
    notification.kind === "duplicate_merged_away" || notification.kind === "duplicate_absorbed"
      ? "/notifications"
      : "/duplicates",
    appBaseUrl,
  ).href;

  return {
    to: recipientEmail,
    subject: SUBJECTS[notification.kind],
    text: [
      event,
      "",
      `Your listing is “${payload.yourListing.title}” (${payload.yourListing.id}).`,
      counterpart,
      "",
      "Automated similarity is a signal for comparison, not proof that two listings are the same.",
      "",
      `Open RFP Hub: ${destination}`,
    ].join("\n"),
  };
}

/** Domain-owned sender: composition stays here; transport choice stays behind the central port. */
export class DuplicateNotificationEmailComposer {
  constructor(
    private readonly email: OutboundEmailPort,
    private readonly appBaseUrl = config.appBaseUrl,
  ) {}

  send(notification: DuplicateNotification, recipientEmail: string): Promise<SendResult> {
    return this.email.send(
      composeDuplicateNotificationEmail(notification, recipientEmail, this.appBaseUrl),
    );
  }
}

function eventCopy(kind: NotificationKind, actor: string): string {
  switch (kind) {
    case "duplicate_suspected":
      return "A similarity check found a possible match involving your listing. It is waiting for review.";
    case "duplicate_confirmed":
      return `${actor} marked the possible match involving your listing as confirmed.`;
    case "duplicate_dismissed":
      return `${actor} dismissed the possible match involving your listing. No action is needed.`;
    case "duplicate_merged_away":
      return `${actor} merged your listing after reviewing the possible match.`;
    case "duplicate_absorbed":
      return `${actor} merged another submission into your listing after reviewing the possible match.`;
    case "duplicate_reopened":
      return `${actor} reopened the possible match involving your listing for another review.`;
  }
}

function duplicatePayload(raw: Record<string, unknown>): DuplicateNotificationPayload {
  const yours = listing(raw.yourListing);
  const other = raw.otherListing === undefined ? undefined : listing(raw.otherListing);
  if (!yours) throw new Error("duplicate notification payload has no valid yourListing");
  if (raw.otherListing !== undefined && !other) {
    throw new Error("duplicate notification payload has no valid otherListing");
  }
  return {
    pairId: typeof raw.pairId === "number" ? raw.pairId : 0,
    similarity: typeof raw.similarity === "number" ? raw.similarity : null,
    yourListing: yours,
    ...(other ? { otherListing: other } : {}),
    action:
      raw.action === "review_match" || raw.action === "view_match" || raw.action === "view_survivor"
        ? raw.action
        : "view_match",
    link: typeof raw.link === "string" ? raw.link : "/notifications",
    decidedBy: raw.decidedBy === "reviewer" ? "reviewer" : null,
  };
}

function listing(raw: unknown): { id: string; title: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  return typeof value.id === "string" && typeof value.title === "string"
    ? { id: value.id, title: safeTitle(value.title) }
    : undefined;
}

/** Keep API-controlled titles from creating new, official-looking lines in outbound text mail. */
function safeTitle(title: string): string {
  const withoutControls = [...title]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
        ? " "
        : character;
    })
    .join("");
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  const capped = [...collapsed].slice(0, 200).join("");
  return capped || "Untitled listing";
}
