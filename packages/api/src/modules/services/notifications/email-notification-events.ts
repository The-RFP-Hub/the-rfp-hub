/** Durable email-only notification rows used by M5 lifecycle and publisher messaging. */
import type { OrganizationRow } from "../../../db/schema.js";
import type { NotificationInsert, Repositories } from "../../repositories/index.js";

/** The private subject-kind prefixes are intentionally outside the public in-app inbox contract. */
export const EMAIL_ONLY_SUBJECTS = {
  account: "email:account",
  publisherVerified: "email:publisher-verified",
  staleListing: "email:stale-listing",
} as const;

/** A unique audit label for one reminder event; eligibility uses the rolling DB cooldown, not this label. */
export function staleReminderSubject(organizationId: number, createdAt: Date): string {
  return `${EMAIL_ONLY_SUBJECTS.staleListing}:${organizationId}:${createdAt.toISOString()}`;
}

/** Notification rows emitted when a reviewer flips an organization to verified. */
export async function publisherVerifiedNotificationInserts(
  repos: Pick<Repositories, "memberships">,
  organization: Pick<OrganizationRow, "id" | "slug" | "name">,
): Promise<NotificationInsert[]> {
  const accountIds = await repos.memberships.accountIdsForOrganization(organization.id);
  return accountIds.map((accountId) => ({
    accountId,
    kind: "publisher_verified",
    subjectKind: EMAIL_ONLY_SUBJECTS.publisherVerified,
    subjectId: organization.id,
    payload: {
      organizationId: organization.id,
      organizationSlug: organization.slug,
      organizationName: organization.name,
    },
  }));
}

export function welcomeNotification(accountId: number): NotificationInsert {
  return {
    accountId,
    kind: "welcome",
    subjectKind: EMAIL_ONLY_SUBJECTS.account,
    subjectId: accountId,
    payload: { event: "signup", accountId },
  };
}
