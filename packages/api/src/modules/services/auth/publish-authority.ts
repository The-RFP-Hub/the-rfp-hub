import type { PublishAuthority, Repositories } from "../../repositories/index.js";

export type { PublishAuthority };

/** Injectable so a test can drive the decision without a database. */
export type PublishAuthorityResolver = (
  repos: Repositories,
  accountId: number,
  namespace: string,
) => Promise<PublishAuthority>;

export async function hasAnyVerifiedMembership(
  repos: Repositories,
  accountId: number,
): Promise<boolean> {
  return repos.memberships.hasAnyVerifiedMembership(accountId);
}

export const resolvePublishAuthority: PublishAuthorityResolver = async (
  repos,
  accountId,
  namespace,
) => repos.memberships.resolvePublishAuthority(accountId, namespace);
