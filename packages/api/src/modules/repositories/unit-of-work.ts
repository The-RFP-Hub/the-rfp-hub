import type { DB, DbLike } from "../../db/client.js";
import { AccountRepository } from "./accounts/account.repository.js";
import { ApiKeyRepository } from "./api-keys/api-key.repository.js";
import { AuditRepository } from "./audit/audit.repository.js";
import { AnalyticsRepository } from "./insights/analytics.repository.js";
import { MembershipInviteRepository } from "./membership-invites/membership-invite.repository.js";
import { MembershipRepository } from "./memberships/membership.repository.js";
import { NotificationRepository } from "./notifications/notification.repository.js";
import { ClaimRepository } from "./opportunities/claim.repository.js";
import { OpportunityRepository } from "./opportunities/opportunity.repository.js";
import { OrganizationRepository } from "./organizations/organization.repository.js";
import { VerificationRunRepository } from "./verification/verification-run.repository.js";

/** The repositories a service may compose. Add domain repositories here as migrations land. */
export interface Repositories {
  readonly accounts: AccountRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly audit: AuditRepository;
  readonly analytics: AnalyticsRepository;
  readonly claims: ClaimRepository;
  readonly membershipInvites: MembershipInviteRepository;
  readonly memberships: MembershipRepository;
  readonly notifications: NotificationRepository;
  readonly opportunities: OpportunityRepository;
  readonly organizations: OrganizationRepository;
  readonly verificationRuns: VerificationRunRepository;
}

/** Build one executor-bound bundle. Repositories are constructed only when first requested. */
export function repositories(exec: DbLike): Repositories {
  let accounts: AccountRepository | undefined;
  let apiKeys: ApiKeyRepository | undefined;
  let audit: AuditRepository | undefined;
  let analytics: AnalyticsRepository | undefined;
  let claims: ClaimRepository | undefined;
  let membershipInvites: MembershipInviteRepository | undefined;
  let memberships: MembershipRepository | undefined;
  let notifications: NotificationRepository | undefined;
  let opportunities: OpportunityRepository | undefined;
  let organizations: OrganizationRepository | undefined;
  let verificationRuns: VerificationRunRepository | undefined;

  return {
    get accounts() {
      accounts ??= new AccountRepository(exec);
      return accounts;
    },
    get apiKeys() {
      apiKeys ??= new ApiKeyRepository(exec);
      return apiKeys;
    },
    get audit() {
      audit ??= new AuditRepository(exec);
      return audit;
    },
    get analytics() {
      analytics ??= new AnalyticsRepository(exec);
      return analytics;
    },
    get claims() {
      claims ??= new ClaimRepository(exec);
      return claims;
    },
    get membershipInvites() {
      membershipInvites ??= new MembershipInviteRepository(exec);
      return membershipInvites;
    },
    get memberships() {
      memberships ??= new MembershipRepository(exec);
      return memberships;
    },
    get notifications() {
      notifications ??= new NotificationRepository(exec);
      return notifications;
    },
    get opportunities() {
      opportunities ??= new OpportunityRepository(exec);
      return opportunities;
    },
    get organizations() {
      organizations ??= new OrganizationRepository(exec);
      return organizations;
    },
    get verificationRuns() {
      verificationRuns ??= new VerificationRunRepository(exec);
      return verificationRuns;
    },
  };
}

/**
 * Run work atomically while exposing only executor-bound repositories. The raw transaction handle
 * never crosses this boundary, so every read and write in `run` stays on the held connection.
 */
export function withTransaction<T>(
  db: DB,
  run: (repos: Repositories) => Promise<T> | T,
): Promise<T> {
  return db.transaction((tx) => Promise.resolve(run(repositories(tx))));
}
