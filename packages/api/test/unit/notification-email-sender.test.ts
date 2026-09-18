import { describe, expect, it, vi } from "vitest";
import type { NotificationRow } from "../../src/db/schema.js";
import type { OutboundEmail } from "../../src/modules/services/email/email.service.js";
import { NotificationEmailSender } from "../../src/modules/services/notifications/notification-email-sender.js";
import { verifyUnsubscribeToken } from "../../src/modules/services/notifications/unsubscribe-token.js";

const SECRET = "unit-test-secret-that-is-long-enough-000";

type EmailNotification = Pick<NotificationRow, "accountId" | "kind" | "payload" | "subjectKind">;
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
    await sender.send({ accountId: 7, kind, subjectKind, payload }, recipient);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      to: recipient,
      subject: expect.any(String),
      text: expect.stringContaining("https://hub.example.org/"),
      ...(kind === "stale_listing_reminder" && { headers: expect.any(Object) }),
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
    expect(() =>
      sender.send({ ...event, accountId: 7, payload } as EmailNotification, recipient),
    ).toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("signs a stale reminder's unsubscribe link for its own recipient against the API origin", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent" });
    const sender = new NotificationEmailSender({ send }, "https://hub.example.org", {
      apiBaseUrl: "https://api.example.org",
      secret: SECRET,
    });
    await sender.send(
      {
        accountId: 7,
        kind: "stale_listing_reminder",
        subjectKind: "email:stale-listing:9:2026-09-14T00:00:00.000Z",
        payload,
      },
      recipient,
    );
    const message = send.mock.calls[0]?.[0] as OutboundEmail;
    const link = /^<(.+)>$/.exec(message.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://api.example.org/v1/email/unsubscribe");
    expect(
      verifyUnsubscribeToken(SECRET, url.searchParams.get("token") ?? "", "stale_listing_reminder"),
    ).toBe(7);
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(message.text).toContain(`Stop these reminders: ${link}`);
  });
});
