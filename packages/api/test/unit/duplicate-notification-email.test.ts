/** Domain email copy: every duplicate kind, cautious language, absolute links and privacy. */
import { describe, expect, it } from "vitest";
import { composeDuplicateNotificationEmail } from "../../src/modules/services/notifications/duplicate-notification-email.js";
import type { NotificationKind } from "../../src/modules/services/notifications/notification.service.js";

const APP_BASE_URL = "https://app.example.org";
const RECIPIENT = "publisher@rfphub.invalid";
const kinds: Array<[NotificationKind, string, string]> = [
  ["duplicate_suspected", "A possible duplicate was found", "waiting for review"],
  ["duplicate_confirmed", "A possible duplicate was reviewed", "marked the possible match"],
  ["duplicate_dismissed", "A possible duplicate was dismissed", "No action is needed"],
  ["duplicate_merged_away", "Your listing was merged", "merged your listing"],
  ["duplicate_absorbed", "Another submission was merged", "merged another submission"],
  ["duplicate_reopened", "A possible duplicate was reopened", "another review"],
];

function notification(kind: NotificationKind, named = true) {
  return {
    kind,
    subjectKind: "duplicate",
    payload: {
      pairId: 42,
      similarity: 0.87,
      yourListing: { id: "mine:grant", title: "My Builders Grant" },
      ...(named ? { otherListing: { id: "public:grant", title: "Public Builders Grant" } } : {}),
      action: "view_match",
      link: "/duplicates",
      decidedBy: kind === "duplicate_suspected" ? null : "reviewer",
    },
  };
}

describe("duplicate notification email composer", () => {
  it.each(kinds)("composes %s in domain language", (kind, subject, phrase) => {
    const email = composeDuplicateNotificationEmail(notification(kind), RECIPIENT, APP_BASE_URL);

    expect(email.to).toBe(RECIPIENT);
    expect(email.subject).toContain(subject);
    expect(email.text).toContain(phrase);
    expect(email.text).toContain("Automated similarity is a signal for comparison, not proof");
    expect(email.text).not.toContain("is definitely a duplicate");
    expect(email.text).toContain(
      kind === "duplicate_merged_away" || kind === "duplicate_absorbed"
        ? "https://app.example.org/notifications"
        : "https://app.example.org/duplicates",
    );
  });

  it("names a counterpart only when the in-app payload named it", () => {
    const named = composeDuplicateNotificationEmail(
      notification("duplicate_confirmed"),
      RECIPIENT,
      APP_BASE_URL,
    );
    expect(named.text).toContain("Public Builders Grant");
    expect(named.text).toContain("public:grant");

    const privateCounterpart = composeDuplicateNotificationEmail(
      notification("duplicate_confirmed", false),
      RECIPIENT,
      APP_BASE_URL,
    );
    expect(privateCounterpart.text).toContain("counterpart is not public");
    expect(privateCounterpart.text).not.toContain("Public Builders Grant");
    expect(privateCounterpart.text).not.toContain("public:grant");
  });

  it("coarsens the actor to reviewer and never invents a person's identity", () => {
    const email = composeDuplicateNotificationEmail(
      notification("duplicate_dismissed"),
      RECIPIENT,
      APP_BASE_URL,
    );
    expect(email.text).toContain("A reviewer dismissed");
    expect(email.text).not.toContain(RECIPIENT);
    expect(email.text).not.toMatch(/reviewer id|account id/i);
  });
});
