import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { toAccountSummary } from "../../services/admin/admin.service.js";
import { AccountService } from "../../services/auth/account.service.js";
import { ClaimService } from "../../services/claims/claim.service.js";
import { ManagedOpportunityService } from "../../services/opportunities/managed-opportunity.service.js";
import { type OrganizationMetadata, ReviewService } from "../../services/review/review.service.js";
import { VerificationService } from "../../services/verification/verification.service.js";
import type {
  AccountListView,
  ClaimListView,
  ManagedOpportunityListView,
  OrganizationListView,
} from "../../shared/api-views.js";
import { bodyOf, handled, idParam, paramsOf, queryOf } from "../../shared/route-helpers.js";

const reviews = new ReviewService();
const claims = new ClaimService();
const managed = new ManagedOpportunityService();
const accountsService = new AccountService();
const verification = new VerificationService();

export const reviewController = {
  listOpportunities: handled(async (request: FastifyRequest) => {
    const query = queryOf<{
      reviewStatus?: "pending" | "approved" | "rejected";
      page?: number;
      limit?: number;
    }>(request);
    // The queue's default is the only status a reviewer has to act on.
    const page = await managed.listForReview({ reviewStatus: "pending", ...query });
    return page satisfies ManagedOpportunityListView;
  }),

  approve: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { reason } = bodyOf<{ reason?: string | null }>(request);
    return reviews.decide(principal.accountId, id, true, reason);
  }),

  reject: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { reason } = bodyOf<{ reason?: string | null }>(request);
    return reviews.decide(principal.accountId, id, false, reason);
  }),

  setListed: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { isListed } = bodyOf<{ isListed: boolean }>(request);
    return reviews.setListed(principal.accountId, id, isListed);
  }),

  verifySource: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const row = await verification.resolvePublicId(id);
    return verification.verify(row.id, {
      actorKind: "user",
      actorAccountId: principal.accountId,
    });
  }),

  listClaims: handled(async (request: FastifyRequest) => {
    const { status } = queryOf<{ status?: "pending" | "approved" | "rejected" | "withdrawn" }>(
      request,
    );
    const items = await claims.listForReview(status ?? "pending");
    return { items } satisfies ClaimListView;
  }),

  approveClaim: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { verifyOrganization } = bodyOf<{ verifyOrganization: boolean }>(request);
    return claims.decide(principal.accountId, idParam(id, "claim"), {
      approve: true,
      verifyOrganization,
    });
  }),

  rejectClaim: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    return claims.decide(principal.accountId, idParam(id, "claim"), { approve: false });
  }),

  verifyOrganization: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    return reviews.setVerified(principal.accountId, slug, true);
  }),

  unverifyOrganization: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    return reviews.setVerified(principal.accountId, slug, false);
  }),

  updateOrganization: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    return reviews.updateOrganization(
      principal.accountId,
      slug,
      bodyOf<OrganizationMetadata>(request),
    );
  }),

  grantMembership: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    const { accountId, role } = bodyOf<{ accountId: number; role?: string }>(request);
    return reviews.grantMembership(principal.accountId, slug, accountId, role);
  }),

  revokeMembership: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug, accountId } = paramsOf<{ slug: string; accountId: string }>(request);
    return reviews.revokeMembership(principal.accountId, slug, idParam(accountId, "account"));
  }),

  searchAccounts: handled(async (request: FastifyRequest) => {
    const { q, limit } = queryOf<{ q?: string; limit?: number }>(request);
    const rows = await accountsService.search(q, limit);
    return { items: rows.map(toAccountSummary) } satisfies AccountListView;
  }),

  searchOrganizations: handled(async (request: FastifyRequest) => {
    const { q, verified, limit } = queryOf<{ q?: string; verified?: boolean; limit?: number }>(
      request,
    );
    const items = await reviews.searchOrganizations(q, verified, limit);
    return { items } satisfies OrganizationListView;
  }),
};
