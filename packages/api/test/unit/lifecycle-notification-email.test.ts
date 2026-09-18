import { describe, expect, it } from "vitest";
import type { DB } from "../../src/db/client.js";
import { AccountService } from "../../src/modules/services/auth/account.service.js";
import {
  publisherVerifiedEventSubjectKind,
  staleReminderEventSubjectKind,
} from "../../src/modules/services/notifications/email-notification-events.js";
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
    expect(email.text).toContain("is verified on RFP Hub");
  });

  it("groups stale listings in actionable copy and strips line controls", () => {
    const email = composeLifecycleNotificationEmail(
      {
        kind: "stale_listing_reminder",
        subjectKind: "email:stale-listing:9:2026-08-01T00:00:00.000Z",
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
      "https://api.example.org/v1/email/unsubscribe?token=t",
    );

    expect(email.subject).toContain("Open Grants");
    expect(email.text).toContain("Quiet Grant (open-grants:one)");
    expect(email.text).toContain("unlist it if it is no longer current");
    expect(email.text).toContain("https://app.example.org/organizations/open-grants");
    expect(email.text).not.toContain("\r");
    expect(email.text).toContain("without an update or successful source verification");
  });

  it("refuses to compose a stale reminder without an unsubscribe link", () => {
    expect(() =>
      composeLifecycleNotificationEmail(
        {
          kind: "stale_listing_reminder",
          subjectKind: "email:stale-listing:9:2026-08-01T00:00:00.000Z",
          payload: {
            organizationId: 9,
            organizationSlug: "open-grants",
            listings: [{ id: "open-grants:one", title: "Grant" }],
          },
        },
        RECIPIENT,
        APP_BASE_URL,
      ),
    ).toThrow(/unsubscribe/);
  });

  it("accepts one publisher_verified label per transition", () => {
    const at = new Date("2026-09-01T00:00:00.000Z");
    const subjectKind = publisherVerifiedEventSubjectKind(9, at);
    expect(subjectKind).not.toBe(publisherVerifiedEventSubjectKind(9, new Date(at.getTime() + 1)));
    const email = composeLifecycleNotificationEmail(
      {
        kind: "publisher_verified",
        subjectKind,
        payload: { organizationId: 9, organizationSlug: "open-grants", organizationName: "Open" },
      },
      RECIPIENT,
      APP_BASE_URL,
    );
    expect(email.headers).toBeUndefined();
  });

  it("uses a unique audit label without making it the cooldown decision", () => {
    const beforeMidnight = staleReminderEventSubjectKind(9, new Date("2026-09-30T23:59:59.000Z"));
    const afterMidnight = staleReminderEventSubjectKind(9, new Date("2026-10-01T00:00:00.000Z"));
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
      ).recordSignupWelcome("m5email-broken-db"),
    ).resolves.toBeUndefined();
    expect(errors).toContain(
      "signup welcome notification could not be recorded; authentication will continue",
    );
  });
});
