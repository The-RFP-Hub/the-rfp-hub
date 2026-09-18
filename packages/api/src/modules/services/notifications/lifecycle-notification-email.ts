/** Text composers for the email-only onboarding and publisher lifecycle events. */
import { config } from "../../../config.js";
import type { NotificationRow } from "../../../db/schema.js";
import type { OutboundEmail } from "../email/email.service.js";

import { EMAIL_ONLY_SUBJECTS } from "./email-notification-events.js";

type LifecycleNotification = Pick<NotificationRow, "kind" | "payload" | "subjectKind">;

export function composeLifecycleNotificationEmail(
  notification: LifecycleNotification,
  recipientEmail: string,
  appBaseUrl = config.appBaseUrl,
): OutboundEmail {
  const validSubject =
    (notification.kind === "welcome" && notification.subjectKind === EMAIL_ONLY_SUBJECTS.account) ||
    (notification.kind === "publisher_verified" &&
      (notification.subjectKind === EMAIL_ONLY_SUBJECTS.publisherVerified ||
        notification.subjectKind.startsWith(`${EMAIL_ONLY_SUBJECTS.publisherVerified}:`))) ||
    (notification.kind === "stale_listing_reminder" &&
      notification.subjectKind.startsWith(`${EMAIL_ONLY_SUBJECTS.staleListing}:`));
  if (!validSubject) {
    throw new Error(`invalid subject for lifecycle notification kind: ${notification.kind}`);
  }
  const destination = new URL(destinationPath(notification), appBaseUrl).href;
  switch (notification.kind) {
    case "welcome":
      return {
        to: recipientEmail,
        subject: "Welcome to RFP Hub",
        text: [
          "Welcome to RFP Hub.",
          "",
          "You can browse funding opportunities without an account, and use your signed-in account to publish and maintain listings when you are a verified publisher.",
          "",
          `Open RFP Hub: ${destination}`,
        ].join("\n"),
      };
    case "publisher_verified": {
      const organization = organizationPayload(notification.payload);
      return {
        to: recipientEmail,
        subject: `${organization.name} is now a verified publisher on RFP Hub`,
        text: [
          `Your publisher organization, ${organization.name} (${organization.slug}), is now verified on RFP Hub.`,
          "",
          "New listings in this namespace can be published without review, subject to the Hub's publishing rules.",
          "",
          `Open your organization: ${destination}`,
        ].join("\n"),
      };
    }
    case "stale_listing_reminder": {
      const stale = stalePayload(notification.payload);
      const lines = stale.listings.map(
        (listing) => `- ${safeText(listing.title)} (${safeText(listing.id)})`,
      );
      return {
        to: recipientEmail,
        subject: `Please review stale listings for ${stale.organizationName}`,
        text: [
          `The following ${lines.length === 1 ? "listing has" : "listings have"} not been updated or confirmed at the source for at least ${stale.inactivityDays} days:`,
          ...lines,
          "",
          `Please update a listing if it is still active, or unlist it if it is no longer current. Listings with no future fixed deadline are automatically closed after ${stale.closeAfterDays} days without an update or successful source verification.`,
          "",
          `Review ${stale.organizationName}: ${destination}`,
        ].join("\n"),
      };
    }
    default:
      throw new Error(
        `notification kind ${JSON.stringify(notification.kind)} is not lifecycle email`,
      );
  }
}

function destinationPath(notification: LifecycleNotification): string {
  if (notification.kind === "welcome") return "/";
  if (notification.kind === "publisher_verified") {
    const organization = organizationPayload(notification.payload);
    return `/organizations/${encodeURIComponent(organization.slug)}`;
  }
  const stale = stalePayload(notification.payload);
  return `/organizations/${encodeURIComponent(stale.organizationSlug)}`;
}

function organizationPayload(raw: Record<string, unknown>): {
  id: number;
  slug: string;
  name: string;
} {
  const id = typeof raw.organizationId === "number" ? raw.organizationId : 0;
  const slug =
    typeof raw.organizationSlug === "string" ? safeText(raw.organizationSlug) : "unknown";
  const name = typeof raw.organizationName === "string" ? safeText(raw.organizationName) : slug;
  if (id <= 0 || slug === "unknown")
    throw new Error("publisher verification notification has invalid organization");
  return { id, slug, name: name || slug };
}

function stalePayload(raw: Record<string, unknown>): {
  organizationId: number;
  organizationSlug: string;
  organizationName: string;
  inactivityDays: number;
  closeAfterDays: number;
  listings: Array<{ id: string; title: string }>;
} {
  const organizationId = typeof raw.organizationId === "number" ? raw.organizationId : 0;
  const organizationSlug =
    typeof raw.organizationSlug === "string" ? safeText(raw.organizationSlug) : "";
  const organizationName =
    typeof raw.organizationName === "string" ? safeText(raw.organizationName) : organizationSlug;
  const inactivityDays = typeof raw.inactivityDays === "number" ? raw.inactivityDays : 60;
  const closeAfterDays = typeof raw.closeAfterDays === "number" ? raw.closeAfterDays : 90;
  const listings = Array.isArray(raw.listings)
    ? raw.listings
        .map((listing) => {
          if (typeof listing !== "object" || listing === null) return undefined;
          const value = listing as Record<string, unknown>;
          if (typeof value.id !== "string" || typeof value.title !== "string") return undefined;
          return { id: safeText(value.id), title: safeText(value.title) };
        })
        .filter((listing): listing is { id: string; title: string } => listing !== undefined)
    : [];
  if (organizationId <= 0 || organizationSlug === "" || listings.length === 0) {
    throw new Error("stale listing notification has invalid payload");
  }
  return {
    organizationId,
    organizationSlug,
    organizationName: organizationName || organizationSlug,
    inactivityDays,
    closeAfterDays,
    listings,
  };
}

/** Prevent data fields from creating new headers or official-looking lines in text email. */
function safeText(value: string): string {
  const withoutControls = [...value]
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
  return withoutControls.replace(/\s+/gu, " ").trim().slice(0, 200) || "Untitled listing";
}
