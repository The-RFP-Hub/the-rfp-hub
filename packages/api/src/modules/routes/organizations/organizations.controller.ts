import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { type OrganizationMetadata, ReviewService } from "../../services/review/review.service.js";
import { forbidden } from "../../shared/http-error.js";
import { bodyOf, handled, paramsOf } from "../../shared/route-helpers.js";

const reviews = new ReviewService();

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
};
