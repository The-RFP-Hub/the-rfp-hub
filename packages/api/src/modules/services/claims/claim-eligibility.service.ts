import { type DB, db as defaultDb } from "../../../db/client.js";
import type { OpportunityRow } from "../../../db/schema.js";
import { type Repositories, repositories } from "../../repositories/index.js";
import { conflict } from "../../shared/http-error.js";

/** Listing visibility controls discovery; ownership controls grants, including existing requests. */
async function hasOwner(repos: Repositories, row: OpportunityRow): Promise<boolean> {
  return (
    row.submittedBy !== null ||
    (await repos.audit.hasPublisherGrant(row.id)) ||
    (await repos.audit.hasSubmitterTransfer(row.id)) ||
    Boolean(row.sourcePublisher && (await repos.organizations.verifiedBySlug(row.sourcePublisher)))
  );
}

export async function isClaimOpen(repos: Repositories, row: OpportunityRow): Promise<boolean> {
  return (
    row.mergedIntoId === null &&
    row.reviewStatus === "approved" &&
    row.isListed &&
    !(await hasOwner(repos, row))
  );
}

export async function assertClaimOpen(repos: Repositories, row: OpportunityRow): Promise<void> {
  if (row.mergedIntoId !== null)
    throw conflict("opportunity_merged", "A merged program cannot receive claims.");
  if (await hasOwner(repos, row))
    throw conflict(
      "already_claimed",
      "This program already has an owner. No further claims are accepted. Contact the owner to request access.",
    );
}

export class ClaimEligibilityService {
  private readonly repos;
  constructor(db: DB = defaultDb) {
    this.repos = repositories(db);
  }
  canClaim(row: OpportunityRow): Promise<boolean> {
    return isClaimOpen(this.repos, row);
  }
}
