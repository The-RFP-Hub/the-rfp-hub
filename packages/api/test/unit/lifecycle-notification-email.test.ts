import { describe, expect, it } from "vitest";
import type { DB } from "../../src/db/client.js";
import { AccountService } from "../../src/modules/services/auth/account.service.js";
import { staleReminderSubject } from "../../src/modules/services/notifications/email-notification-events.js";
import { composeLifecycleNotificationEmail } from "../../src/modules/services/notifications/lifecycle-notification-email.js";

const APP_BASE_URL = "https://app.example.org";
const RECIPIENT = "publisher@rfphub.invalid";

describe("lifecycle notification emails", () => {
  it("welcomes an account without exposing internal identifiers", () => {
    const email = composeLifecycleNotificationEmail(
      {
        kind: "welcome",
        subjectKind: "email:account",
        payload: { event: "signup", accountId: 42 },
      },
      RECIPIENT,
      APP_BASE_URL,
    );

    expect(email).toMatchObject({ to: RECIPIENT, subject: "Welcome to RFP Hub" });
    expect(email.text).toContain("Welcome to RFP Hub");
    expect(email.text).toContain("https://app.example.org/");
    expect(email.text).not.toContain("42");
  });

  it("uses verified organization facts for the publisher transition", () => {
    const email = composeLifecycleNotificationEmail(
      {
        kind: "publisher_verified",
        subjectKind: "email:publisher-verified",
        payload: {
          organizationId: 9,
          organizationSlug: "open-grants",
          organizationName: "Open Grants",
        },
      },
      RECIPIENT,
      APP_BASE_URL,
    );

    expect(email.to).toBe(RECIPIENT);
    expect(email.subject).toContain("Open Grants");
    expect(email.text).toContain("https://app.example.org/organizations/open-grants");
    expect(email.text).toContain("now verified");
  });

  it("groups stale listings in actionable copy and strips line controls", () => {
    const email = composeLifecycleNotificationEmail(
      {
        kind: "stale_listing_reminder",
        subjectKind: "2026-08:9",
        payload: {
          organizationId: 9,
          organizationSlug: "open-grants",
          organizationName: "Open Grants",
          inactivityDays: 60,
          closeAfterDays: 90,
          listings: [{ id: "open-grants:one", title: "Quiet\r\nGrant" }],
        },
      },
      RECIPIENT,
      APP_BASE_URL,
    );

    expect(email.subject).toContain("Open Grants");
    expect(email.text).toContain("Quiet Grant (open-grants:one)");
    expect(email.text).toContain("unlist it if it is no longer current");
    expect(email.text).toContain("https://app.example.org/organizations/open-grants");
    expect(email.text).not.toContain("\r");
  });

  it("uses a unique audit label without making it the cooldown decision", () => {
    const beforeMidnight = staleReminderSubject(9, new Date("2026-09-30T23:59:59.000Z"));
    const afterMidnight = staleReminderSubject(9, new Date("2026-10-01T00:00:00.000Z"));
    expect(beforeMidnight).not.toBe(afterMidnight);
    expect(beforeMidnight).toContain("email:stale-listing:9:");
  });

  it("swallows a post-signup database failure so authentication can still finish", async () => {
    const errors: string[] = [];
    const brokenDb = {
      transaction: async () => {
        throw new Error("test database outage");
      },
    } as unknown as DB;
    await expect(
      new AccountService(
        brokenDb,
        { error: (_payload, message) => errors.push(message) },
        { enqueue() {} },
      ).ensureSignupWelcome("m5email-broken-db"),
    ).resolves.toBeUndefined();
    expect(errors).toContain(
      "signup welcome notification could not be recorded; authentication will continue",
    );
  });
});
