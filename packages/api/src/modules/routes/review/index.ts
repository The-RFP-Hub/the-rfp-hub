/**
 * `/v1/review` — the T3 surface. Every route is `requireRole("reviewer")`, which is session-only:
 * a global role never elevates an API key, so a leaked reviewer key cannot approve anything.
 *
 * Duplicate merge/confirm/dismiss and the manual source-verify trigger belong on this prefix and
 * are added by the waves that implement the machinery behind them — a review action with no
 * detector or verifier behind it would be a button that does nothing.
 */
import type { FastifyInstance } from "fastify";
import { reviewController } from "./review.controller.js";

export const review = async (router: FastifyInstance): Promise<void> => {
  const guard = router.auth.requireRole("reviewer");
  const slugParams = {
    type: "object",
    required: ["slug"],
    properties: { slug: { type: "string" } },
  };
  const idParams = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
  const errors = {
    401: { $ref: "ErrorResponse#" },
    403: { $ref: "ErrorResponse#" },
    404: { $ref: "ErrorResponse#" },
  };

  router.get(
    "/opportunities",
    {
      onRequest: guard,
      schema: {
        operationId: "listReviewOpportunities",
        tags: ["review"],
        summary: "The review queue",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: { 200: { $ref: "ManagedOpportunityList#" }, ...errors },
      },
    },
    reviewController.listOpportunities,
  );

  router.post(
    "/opportunities/:id/approve",
    {
      onRequest: guard,
      schema: {
        operationId: "approveOpportunity",
        tags: ["review"],
        summary: "Approve one entry",
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: ["string", "null"] } },
        },
        response: { 200: { $ref: "ReviewDecision#" }, ...errors },
      },
    },
    reviewController.approve,
  );

  router.post(
    "/opportunities/:id/reject",
    {
      onRequest: guard,
      schema: {
        operationId: "rejectOpportunity",
        tags: ["review"],
        summary: "Reject one entry (which also unlists it)",
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: ["string", "null"] } },
        },
        response: { 200: { $ref: "ReviewDecision#" }, ...errors },
      },
    },
    reviewController.reject,
  );

  router.patch(
    "/opportunities/:id",
    {
      onRequest: guard,
      schema: {
        operationId: "updateReviewOpportunity",
        tags: ["review"],
        summary: "Unlist or relist one entry",
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: {
          type: "object",
          required: ["isListed"],
          additionalProperties: false,
          properties: { isListed: { type: "boolean" } },
        },
        response: { 200: { $ref: "ReviewDecision#" }, ...errors },
      },
    },
    reviewController.setListed,
  );

  router.get(
    "/claims",
    {
      onRequest: guard,
      schema: {
        operationId: "listClaims",
        tags: ["review"],
        summary: "Queued ownership claims",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["pending", "approved", "rejected", "withdrawn"] },
          },
        },
        response: { 200: { $ref: "ClaimList#" }, ...errors },
      },
    },
    reviewController.listClaims,
  );

  router.post(
    "/claims/:id/approve",
    {
      onRequest: guard,
      schema: {
        operationId: "approveClaim",
        tags: ["review"],
        summary: "Approve a claim, deciding explicitly whether to verify the organisation",
        description:
          "`verifyOrganization: false` transfers publisher ownership but does NOT unlock auto-approval — that requires a verified organisation, so the publisher's future writes keep landing pending. The response states which of the two happened.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        },
        body: {
          type: "object",
          required: ["verifyOrganization"],
          additionalProperties: false,
          properties: { verifyOrganization: { type: "boolean" } },
        },
        response: { 200: { $ref: "ClaimResult#" }, 409: { $ref: "ErrorResponse#" }, ...errors },
      },
    },
    reviewController.approveClaim,
  );

  router.post(
    "/claims/:id/reject",
    {
      onRequest: guard,
      schema: {
        operationId: "rejectClaim",
        tags: ["review"],
        summary: "Reject a claim",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        },
        response: { 200: { $ref: "ClaimResult#" }, 409: { $ref: "ErrorResponse#" }, ...errors },
      },
    },
    reviewController.rejectClaim,
  );

  router.post(
    "/organizations/:slug/verify",
    {
      onRequest: guard,
      schema: {
        operationId: "verifyOrganization",
        tags: ["review"],
        summary: "Verify an organisation — every member becomes a publisher of its namespace",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        response: { 200: { $ref: "OrganizationSummary#" }, ...errors },
      },
    },
    reviewController.verifyOrganization,
  );

  router.post(
    "/organizations/:slug/unverify",
    {
      onRequest: guard,
      schema: {
        operationId: "unverifyOrganization",
        tags: ["review"],
        summary: "Withdraw verification — auto-approval for that namespace stops immediately",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        response: { 200: { $ref: "OrganizationSummary#" }, ...errors },
      },
    },
    reviewController.unverifyOrganization,
  );

  router.patch(
    "/organizations/:slug",
    {
      onRequest: guard,
      schema: {
        operationId: "updateOrganizationAsReviewer",
        tags: ["review"],
        summary: "Edit an organisation's directory entry",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        body: organizationMetadataSchema,
        response: {
          200: { $ref: "OrganizationSummary#" },
          400: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.updateOrganization,
  );

  router.post(
    "/organizations/:slug/members",
    {
      onRequest: guard,
      schema: {
        operationId: "grantOrganizationMembership",
        tags: ["review"],
        summary: "Grant an account publishing rights on an organisation",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        body: {
          type: "object",
          required: ["accountId"],
          additionalProperties: false,
          properties: {
            accountId: { type: "integer" },
            role: { type: "string", enum: ["owner", "admin", "publisher"] },
          },
        },
        response: {
          200: { $ref: "MembershipResult#" },
          400: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.grantMembership,
  );

  router.delete(
    "/organizations/:slug/members/:accountId",
    {
      onRequest: guard,
      schema: {
        operationId: "revokeOrganizationMembership",
        tags: ["review"],
        summary: "Revoke an account's publishing rights on an organisation",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["slug", "accountId"],
          properties: {
            slug: { type: "string" },
            accountId: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: { 200: { $ref: "MembershipResult#" }, ...errors },
      },
    },
    reviewController.revokeMembership,
  );

  router.get(
    "/accounts",
    {
      onRequest: guard,
      schema: {
        operationId: "searchAccounts",
        tags: ["review"],
        summary: "Find accounts by handle, display name or provider subject",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        response: { 200: { $ref: "AccountList#" }, ...errors },
      },
    },
    reviewController.searchAccounts,
  );

  router.get(
    "/organizations",
    {
      onRequest: guard,
      schema: {
        operationId: "searchOrganizations",
        tags: ["review"],
        summary: "Find organisations, optionally filtered by verification",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string" },
            verified: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        response: { 200: { $ref: "OrganizationList#" }, ...errors },
      },
    },
    reviewController.searchOrganizations,
  );
};

/** Shared by the reviewer route and the organisation-owner route — one editable field set. */
export const organizationMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: ["string", "null"] },
    website: { type: ["string", "null"] },
    logoUrl: { type: ["string", "null"] },
    bannerUrl: { type: ["string", "null"] },
    ecosystems: { type: "array", items: { type: "string" } },
  },
} as const;
