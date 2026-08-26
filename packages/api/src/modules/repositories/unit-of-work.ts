import type { DB, DbLike } from "../../db/client.js";
import { AccountRepository } from "./accounts/account.repository.js";
import { ApiKeyRepository } from "./api-keys/api-key.repository.js";
import { AuditRepository } from "./audit/audit.repository.js";
import { MembershipInviteRepository } from "./membership-invites/membership-invite.repository.js";
import { MembershipRepository } from "./memberships/membership.repository.js";
import { OpportunityRepository } from "./opportunities/opportunity.repository.js";
import { OrganizationRepository } from "./organizations/organization.repository.js";

/** The repositories a service may compose. Add domain repositories here as migrations land. */
export interface Repositories {
  readonly accounts: AccountRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly audit: AuditRepository;
  readonly membershipInvites: MembershipInviteRepository;
  readonly memberships: MembershipRepository;
  readonly opportunities: OpportunityRepository;
  readonly organizations: OrganizationRepository;
}

/** Build one executor-bound bundle. Repositories are constructed only when first requested. */
export function repositories(exec: DbLike): Repositories {
  let accounts: AccountRepository | undefined;
  let apiKeys: ApiKeyRepository | undefined;
  let audit: AuditRepository | undefined;
  let membershipInvites: MembershipInviteRepository | undefined;
  let memberships: MembershipRepository | undefined;
  let opportunities: OpportunityRepository | undefined;
  let organizations: OrganizationRepository | undefined;

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
    get membershipInvites() {
      membershipInvites ??= new MembershipInviteRepository(exec);
      return membershipInvites;
    },
    get memberships() {
      memberships ??= new MembershipRepository(exec);
      return memberships;
    },
    get opportunities() {
      opportunities ??= new OpportunityRepository(exec);
      return opportunities;
    },
    get organizations() {
      organizations ??= new OrganizationRepository(exec);
      return organizations;
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
