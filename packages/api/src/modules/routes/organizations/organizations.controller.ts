import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { ManagedOpportunityService } from "../../services/opportunities/managed-opportunity.service.js";
import { type OrganizationMetadata, ReviewService } from "../../services/review/review.service.js";
import type { ManagedOpportunityListView } from "../../shared/api-views.js";
import { hasMembership, hasVerifiedMembership } from "../../shared/capabilities.js";
import { forbidden } from "../../shared/http-error.js";
import { bodyOf, handled, paramsOf, queryOf } from "../../shared/route-helpers.js";

const reviews = new ReviewService();
const managed = new ManagedOpportunityService();

export const organizationsController = {
  patch: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    const reviewer = principal.role === "reviewer" || principal.role === "admin";
    if (!reviewer && !(await reviews.isOrgManager(principal.accountId, slug))) {
      throw forbidden(
        "not_an_org_manager",
        `editing \`${slug}\` requires an owner or admin membership on it.`,
      );
    }
    return reviews.updateOrganization(
      principal.accountId,
      slug,
      bodyOf<OrganizationMetadata>(request),
    );
  }),

  /**
   * Everything published under this organisation's namespace, to its own members.
   *
   * ANY membership, verified or not. Verification governs PUBLISHING — whether a write lands
   * approved — and has nothing to say about who may look at the organisation's own queue. A member
   * of an unverified organisation still needs to see what their colleagues have submitted, and
   * making them wait for verification to do it would be an unrelated rule enforced by accident.
   *
   * The unknown-slug 404 comes FIRST, deliberately, and is not an existence oracle: organisations
   * are a public directory (`GET /v1/publishers`, `GET /v1/organizations`), so their existence is
   * not a secret. What is secret is their unpublished queue, and that is what the 403 protects.
   */
  opportunities: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug } = paramsOf<{ slug: string }>(request);
    await reviews.requireOrganization(slug);
    if (!hasMembership(principal, slug)) {
      throw forbidden(
        "not_a_member",
        `you hold no membership on \`${slug}\`, so you cannot see what it has submitted.`,
      );
    }
    const query = queryOf<{
      reviewStatus?: "pending" | "approved" | "rejected";
      page?: number;
      limit?: number;
    }>(request);
    const page = await managed.listForNamespace(slug, query);
    return page satisfies ManagedOpportunityListView;
  }),

  /**
   * Release one of the organisation's own pending entries.
   *
   * VERIFIED membership, unlike the list above — looking is not publishing. The check here is the
   * cheap fail-fast against the principal resolved at authentication; the one that DECIDES is made
   * again inside the approving transaction, under the entry's lock, because a membership resolved
   * when the bearer was exchanged can be revoked while the request is still in flight.
   */
  approve: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug, id } = paramsOf<{ slug: string; id: string }>(request);
    await reviews.requireOrganization(slug);
    if (!hasVerifiedMembership(principal, slug)) {
      throw forbidden(
        "not_a_verified_member",
        `approving an entry published under \`${slug}\` requires a membership on it while it is a verified publisher.`,
      );
    }
    return reviews.approveForNamespace(principal.accountId, slug, id);
  }),

  /**
   * Refuse one of the organisation's own pending entries — with a reason, always.
   *
   * The guards are approve's, verbatim (see the service): what makes a member trusted to publish is
   * what makes them trusted to refuse. What differs is that the reason is mandatory, because an
   * organisation refusing a third party's account of its own programme is exactly the decision that
   * has to be answerable for itself.
   */
  reject: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { slug, id } = paramsOf<{ slug: string; id: string }>(request);
    const { reason } = bodyOf<{ reason?: string }>(request);
    await reviews.requireOrganization(slug);
    if (!hasVerifiedMembership(principal, slug)) {
      throw forbidden(
        "not_a_verified_member",
        `deciding an entry published under \`${slug}\` requires a membership on it while it is a verified publisher.`,
      );
    }
    return reviews.rejectForNamespace(principal.accountId, slug, id, reason ?? "");
  }),
};
