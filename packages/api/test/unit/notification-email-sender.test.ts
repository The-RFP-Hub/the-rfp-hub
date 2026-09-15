import { describe, expect, it, vi } from "vitest";
import type { NotificationRow } from "../../src/db/schema.js";
import { NotificationEmailSender } from "../../src/modules/services/notifications/notification-email-sender.js";

type EmailNotification = Pick<NotificationRow, "kind" | "payload" | "subjectKind">;
const recipient = "publisher@example.org";
const payload = {
  organizationId: 9,
  organizationSlug: "grants",
  organizationName: "Grants",
  listings: [{ id: "grants:one", title: "Grant" }],
  yourListing: { id: "grants:one", title: "Grant" },
};

describe("notification email sender", () => {
  it.each<EmailNotification["kind"]>([
    "duplicate_suspected",
    "duplicate_confirmed",
    "duplicate_dismissed",
    "duplicate_merged_away",
    "duplicate_absorbed",
    "duplicate_reopened",
    "welcome",
    "publisher_verified",
    "stale_listing_reminder",
  ])("sends a rendered %s email through the supplied transport", async (kind) => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const subjectKind = kind.startsWith("duplicate_")
      ? "duplicate"
      : kind === "welcome"
        ? "email:account"
        : kind === "publisher_verified"
          ? "email:publisher-verified"
          : "email:stale-listing:9:2026-09-14T00:00:00.000Z";
    const sender = new NotificationEmailSender({ send }, "https://hub.example.org");
    await sender.send({ kind, subjectKind, payload }, recipient);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      to: recipient,
      subject: expect.any(String),
      text: expect.stringContaining("https://hub.example.org/"),
    });
  });

  it.each([
    { kind: "future_event", subjectKind: "email:account" },
    { kind: "welcome", subjectKind: "duplicate" },
    { kind: "welcome", subjectKind: "unknown" },
    { kind: "duplicate_suspected", subjectKind: "email:account" },
    { kind: "publisher_verified", subjectKind: "email:account" },
    { kind: "stale_listing_reminder", subjectKind: "email:account" },
  ])("rejects invalid event routing before sending: $kind / $subjectKind", (event) => {
    const send = vi.fn();
    const sender = new NotificationEmailSender({ send }, "https://hub.example.org");
    expect(() => sender.send({ ...event, payload } as EmailNotification, recipient)).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
