import type { Opportunity } from "@the-rfp-hub/standard";
import { type DB, db as defaultDb } from "../../../db/client.js";
import type { AccountRow, OpportunityRow } from "../../../db/schema.js";
import { toStandard } from "../../mappers/opportunity.mapper.js";
import { type Repositories, repositories, withTransaction } from "../../repositories/index.js";
import { effectiveCaps } from "../../shared/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import type { RequestPrincipal } from "../auth/principal.service.js";
import { isPrivileged } from "./opportunity-meta.service.js";

/** Personal attribution is managed separately from the organization's publishing access. */
export class OpportunitySubmitterService {
  private readonly repos;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  async canAssume(principal: RequestPrincipal, row: OpportunityRow): Promise<boolean> {
    if (principal.credentialKind !== "session" || row.mergedIntoId !== null || !row.sourcePublisher)
      return false;
    const membership = principal.memberships.find((m) => m.slug === row.sourcePublisher);
    if (!membership?.verified) return false;
    const role = await this.repos.memberships.roleForAccountAndOrganizationSlug(
      principal.accountId,
      row.sourcePublisher,
    );
    return role === "owner" || role === "admin";
  }

  async assume(principal: RequestPrincipal, publicId: string): Promise<Opportunity> {
    if (principal.credentialKind !== "session")
      throw forbidden("session_required", "Sign in to change the program's submitter.");
    const entry = await this.repos.opportunities.findByPublicId(publicId);
    if (!entry) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    if (entry.reviewStatus !== "approved" || !entry.isListed) {
      if (!isPrivileged(entry, principal))
        throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    }
    if (!(await this.canAssume(principal, entry))) {
      throw forbidden(
        "organization_manager_required",
        "Only an owner or admin of this program's verified publisher organization can change its submitter.",
      );
    }
    return withTransaction(this.db, async (repos) => {
      const row = await repos.opportunities.lockById(entry.id);
      if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
      if (row.mergedIntoId !== null)
        throw conflict("opportunity_merged", "A merged listing cannot change its submitter.");
      const org = row.sourcePublisher
        ? await repos.organizations.findBySlug(row.sourcePublisher)
        : undefined;
      const lockedOrg = org ? await repos.organizations.lockByIdForClaim(org.id) : undefined;
      const role = lockedOrg
        ? await repos.memberships.lockRoleForManagerCheck(principal.accountId, lockedOrg.id)
        : undefined;
      if (!lockedOrg?.verified || (role !== "owner" && role !== "admin")) {
        throw forbidden(
          "organization_manager_required",
          "Only an owner or admin of this program's verified publisher organization can change its submitter.",
        );
      }
      const account = await repos.accounts.findById(principal.accountId);
      const name = account?.handle ?? account?.displayName;
      if (!name)
        throw badRequest(
          "public_name_required",
          "Set a public handle or display name in your account before taking over the submission.",
        );
      if (!account) throw notFound("Your account no longer exists.");
      return this.apply(repos, principal, row, account);
    });
  }

  async assign(
    principal: RequestPrincipal,
    publicId: string,
    accountId: number,
    reason: string,
  ): Promise<Opportunity> {
    if (!effectiveCaps(principal).canAdmin)
      throw forbidden(
        "admin_required",
        "Only a signed-in Hub administrator can assign a submitter.",
      );
    const explanation = reason.trim();
    if (!explanation || explanation.length > 1000)
      throw badRequest("reason_required", "Provide a reason between 1 and 1000 characters.");
    if (!Number.isSafeInteger(accountId) || accountId < 1)
      throw badRequest("account_required", "Select an existing account.");
    const entry = await this.repos.opportunities.findByPublicId(publicId);
    if (!entry) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
    return withTransaction(this.db, async (repos) => {
      const row = await repos.opportunities.lockById(entry.id);
      if (!row) throw notFound(`no opportunity ${JSON.stringify(publicId)}.`);
      if (row.mergedIntoId !== null)
        throw conflict("opportunity_merged", "A merged listing cannot change its submitter.");
      // Lock account rows in a stable order, including the actor's live administrative role.
      const locked = new Map<number, AccountRow>();
      for (const id of [...new Set([principal.accountId, accountId])].sort((a, b) => a - b)) {
        const account = await repos.accounts.lockById(id);
        if (account) locked.set(id, account);
      }
      if (locked.get(principal.accountId)?.globalRole !== "admin")
        throw forbidden("admin_required", "Your administrator permission is no longer active.");
      const target = locked.get(accountId);
      if (!target) throw notFound(`no account ${accountId}.`);
      if (!target.authUserId || !(await repos.accounts.identityBySubject(target.authUserId)))
        throw conflict("unreachable_account", "Select an account with an active sign-in identity.");
      if (!(target.handle ?? target.displayName)?.trim())
        throw badRequest(
          "public_name_required",
          "The selected account needs a public handle or display name.",
        );
      return this.apply(repos, principal, row, target, explanation);
    });
  }

  private async apply(
    repos: Repositories,
    principal: RequestPrincipal,
    row: OpportunityRow,
    account: AccountRow,
    explanation?: string,
  ): Promise<Opportunity> {
    const name = account.handle ?? account.displayName;
    if (row.submittedBy === account.id && row.sourceSubmittedBy === name) return toStandard(row);
    const updated = await repos.opportunities.update(row.id, {
      submittedBy: account.id,
      sourceSubmittedBy: name,
      updatedAt: new Date(),
    });
    if (!updated) throw new Error("failed to change program submitter");
    await repos.audit.record({
      subjectKind: "opportunity",
      subjectId: row.id,
      action: "update",
      actorKind: "user",
      actorAccountId: principal.accountId,
      patch: {
        reason: "submitter_transfer",
        ...(explanation ? { explanation } : {}),
        submittedByAccountId: { before: row.submittedBy, after: account.id },
        submittedBy: { before: row.sourceSubmittedBy, after: name },
      },
    });
    return toStandard(updated);
  }
}
