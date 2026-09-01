/**
 * `/v1/review` — the T3 surface. Every route is `requireRole("reviewer")`, which is session-only:
 * a global role never elevates an API key, so a leaked reviewer key cannot approve anything.
 *
 * Triggering a source verification is a REVIEWER capability, not an administrator one: the tier
 * contract already gives T3 the power to override provenance, and a reviewer who can approve an
 * entry but cannot ask whether its link resolves is being asked to decide with less evidence than
 * the system has. The T4 route survives alongside it for bulk and scripted use.
 */
import type { FastifyInstance } from "fastify";
import { meteredAuth } from "../shared/rate-limit-key.js";
import { reviewController } from "./review.controller.js";

/**
 * A reviewer decides at human pace — read the entry, then click once. 30/min is far above what
 * that looks like and far below what a runaway client or a stolen session could spend.
 */
const REVIEW_DECISION = { max: 30, timeWindow: "1 minute" } as const;

export const review = async (router: FastifyInstance): Promise<void> => {
  const guard = router.auth.requireRole("reviewer");
  /**
   * The chain every review WRITE uses: resolve, meter, then the role gate. Called PER ROUTE, since
   * each call mints its own store child and therefore its own bucket, as everywhere else.
   */
  const metered = () => meteredAuth(router, guard, REVIEW_DECISION);
  const slugParams = {
    type: "object",
    required: ["slug"],
    properties: { slug: { type: "string" } },
  };
  const idParams = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
  /** A duplicate PAIR's own numeric id — not an opportunity's public id. */
  const pairParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9]+$" } },
  };
  const reopenPairParams = {
    type: "object",
    required: ["pairId"],
    properties: { pairId: { type: "string", pattern: "^[0-9]+$" } },
  };
  const errors = {
    401: { $ref: "ErrorResponse#" },
    403: { $ref: "ErrorResponse#" },
    404: { $ref: "ErrorResponse#" },
  };
  const claimDecidedConflict = {
    type: "object",
    additionalProperties: false,
    description: "`claim_decided` when the claim is no longer pending.",
    required: ["error", "message"],
    properties: {
      error: { type: "string", enum: ["claim_decided"] },
      message: { type: "string" },
    },
  };
  const claimApprovalConflict = {
    ...claimDecidedConflict,
    description:
      "`claim_decided` when the claim is no longer pending; `opportunity_merged` when approval would transfer ownership from a terminal merge loser.",
    properties: {
      ...claimDecidedConflict.properties,
      error: { type: "string", enum: ["claim_decided", "opportunity_merged"] },
    },
  };
  const duplicateReopenConflict = {
    type: "object",
    additionalProperties: false,
    description:
      "`already_merged` when the pair is terminal; `duplicate_not_dismissed` when it is confirmed and must use the existing duplicate decision actions.",
    required: ["error", "message"],
    properties: {
      error: { type: "string", enum: ["already_merged", "duplicate_not_dismissed"] },
      message: { type: "string" },
    },
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
            id: {
              type: "string",
              description: "Exact public id; bypasses the default pending queue.",
            },
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

  router.get(
    "/opportunities/:id",
    {
      onRequest: guard,
      schema: {
        operationId: "getReviewOpportunity",
        tags: ["review"],
        summary: "One entry in full, whatever its review status",
        description:
          "The reviewer's counterpart to `GET /v1/me/opportunities/{id}`, which is scoped to entries the caller owns. Everything a reviewer is sent to — the queue, a claim, a duplicate pair — is by definition somebody else's entry, so deciding it needs a read that is entitled by ROLE rather than by ownership. Serves pending, rejected and unlisted records; the T3 gate is the entitlement.",
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: { $ref: "Opportunity#" }, ...errors },
      },
    },
    reviewController.findOpportunity,
  );

  router.post(
    "/opportunities/:id/approve",
    {
      onRequest: metered(),
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
        response: {
          200: { $ref: "ReviewDecision#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.approve,
  );

  router.post(
    "/opportunities/:id/reject",
    {
      onRequest: metered(),
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
        response: {
          200: { $ref: "ReviewDecision#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.reject,
  );

  router.patch(
    "/opportunities/:id",
    {
      onRequest: metered(),
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
        response: {
          200: { $ref: "ReviewDecision#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.setListed,
  );

  router.post(
    "/opportunities/:id/verify",
    {
      // The one review action that reaches the network: the limit is also what stops a reviewer
      // holding the button down from turning this service into an amplifier against somebody's site.
      onRequest: metered(),
      schema: {
        operationId: "verifyOpportunitySource",
        tags: ["review"],
        summary: "Fetch this entry's applicationUrl now and record what it says",
        description:
          "Records a run whatever happens — a refused address, a timeout and a soft 404 are all answers a reviewer needs. `matched` is a LOW-BAR anti-spam signal (the page exists and its title is about the same program), not a fact-check: an administrator still approves. 400 when the entry carries no `applicationUrl`, because there is then nothing to check it against.",
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: {
          200: { $ref: "VerificationRun#" },
          400: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.verifySource,
  );

  router.get(
    "/duplicates",
    {
      onRequest: guard,
      schema: {
        operationId: "listDuplicatePairs",
        tags: ["review"],
        summary: "The duplicate queue — both sides of every pair",
        description:
          "Unlike the submitter-facing `/v1/opportunities/{id}/duplicates`, this shows pairs whose other side is pending or unlisted: deciding between two entries is what a reviewer is for.",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["suspected", "confirmed", "dismissed", "merged"],
            },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        response: { 200: { $ref: "DuplicatePairList#" }, ...errors },
      },
    },
    reviewController.listDuplicates,
  );

  router.post(
    "/duplicates/:id/confirm",
    {
      onRequest: metered(),
      schema: {
        operationId: "confirmDuplicate",
        tags: ["review"],
        summary: "Record that two entries really are the same program",
        description:
          "Changes the pair's status only. Neither entry is touched — deciding which one survives is a separate, destructive action.",
        security: [{ bearerAuth: [] }],
        params: pairParams,
        response: { 200: { $ref: "DuplicatePair#" }, 409: { $ref: "ErrorResponse#" }, ...errors },
      },
    },
    reviewController.confirmDuplicate,
  );

  router.post(
    "/duplicates/:id/dismiss",
    {
      onRequest: metered(),
      schema: {
        operationId: "dismissDuplicate",
        tags: ["review"],
        summary: "Record that two similar entries are different programs",
        description:
          "A dismissal is permanent as far as the detector is concerned: re-running detection never resurrects a dismissed pair, because a re-run has no new information about a judgement somebody already made.",
        security: [{ bearerAuth: [] }],
        params: pairParams,
        response: { 200: { $ref: "DuplicatePair#" }, 409: { $ref: "ErrorResponse#" }, ...errors },
      },
    },
    reviewController.dismissDuplicate,
  );

  router.post(
    "/duplicates/:pairId/reopen",
    {
      onRequest: metered(),
      schema: {
        operationId: "reopenDuplicate",
        tags: ["review"],
        summary: "Return a dismissed pair to the suspected duplicate queue",
        description:
          "Idempotent for an already-suspected pair. A merged pair is terminal, while a confirmed pair remains a duplicate decision and must use the existing confirm/dismiss actions.",
        security: [{ bearerAuth: [] }],
        params: reopenPairParams,
        response: {
          200: { $ref: "DuplicatePair#" },
          409: duplicateReopenConflict,
          ...errors,
        },
      },
    },
    reviewController.reopenDuplicate,
  );

  router.post(
    "/duplicates/:id/merge",
    {
      onRequest: metered(),
      schema: {
        operationId: "mergeDuplicate",
        tags: ["review"],
        summary: "Keep one entry of a pair and retire the other into it",
        description:
          "The loser is rejected, unlisted, archived and pointed at the survivor; when its id was public at merge time, a future public read remains a 404 but may name the currently-public survivor in its body. The survivor must be approved AND listed, and must not itself have been merged — that check is what prevents chains and cycles (409 naming the real survivor). `fields` copies a whitelist from the loser; the result is re-validated against the Standard inside the transaction and the whole merge rolls back if it would no longer conform.",
        security: [{ bearerAuth: [] }],
        params: pairParams,
        body: {
          type: "object",
          required: ["survivorId"],
          additionalProperties: false,
          properties: {
            survivorId: {
              type: "string",
              description: "The public id of whichever side of the pair is to remain public.",
            },
            fields: { type: "array", items: { type: "string" } },
          },
        },
        response: { 200: { $ref: "MergeResult#" }, 409: { $ref: "ErrorResponse#" }, ...errors },
      },
    },
    reviewController.mergeDuplicate,
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
      onRequest: metered(),
      schema: {
        operationId: "approveClaim",
        tags: ["review"],
        summary: "Approve a claim, deciding explicitly whether to verify the organization",
        description:
          "`verifyOrganization: false` transfers publisher ownership but does NOT unlock auto-approval — that requires a verified organization, so the publisher's future writes keep landing pending. The response states which of the two happened.",
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
        response: { 200: { $ref: "ClaimResult#" }, 409: claimApprovalConflict, ...errors },
      },
    },
    reviewController.approveClaim,
  );

  router.post(
    "/claims/:id/reject",
    {
      onRequest: metered(),
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
        response: { 200: { $ref: "ClaimResult#" }, 409: claimDecidedConflict, ...errors },
      },
    },
    reviewController.rejectClaim,
  );

  router.post(
    "/organizations/:slug/verify",
    {
      onRequest: metered(),
      schema: {
        operationId: "verifyOrganization",
        tags: ["review"],
        summary: "Verify an organization — every member becomes a publisher of its namespace",
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
      onRequest: metered(),
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
      onRequest: metered(),
      schema: {
        operationId: "updateOrganizationAsReviewer",
        tags: ["review"],
        summary: "Edit an organization's directory entry",
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
      onRequest: metered(),
      schema: {
        operationId: "grantOrganizationMembership",
        tags: ["review"],
        summary: "Grant an account publishing rights on an organization",
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
      onRequest: metered(),
      schema: {
        operationId: "revokeOrganizationMembership",
        tags: ["review"],
        summary: "Revoke an account's publishing rights on an organization",
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

  router.post(
    "/organizations/:slug/invites",
    {
      onRequest: metered(),
      schema: {
        operationId: "createOrganizationMembershipInvite",
        tags: ["review"],
        summary: "Invite an email address to receive an organization membership on sign-in",
        description:
          "The membership is not active yet. It is applied the first time a person signs in with, and proves ownership of, this email address.",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: {
            email: { type: "string", format: "email", minLength: 3, maxLength: 320 },
            role: { type: "string", enum: ["owner", "admin", "publisher"] },
          },
        },
        response: {
          200: { $ref: "MembershipInvite#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    reviewController.createMembershipInvite,
  );

  router.get(
    "/organizations/:slug/invites",
    {
      onRequest: guard,
      schema: {
        operationId: "listOrganizationMembershipInvites",
        tags: ["review"],
        summary: "List pending membership invites for an organization",
        security: [{ bearerAuth: [] }],
        params: slugParams,
        response: { 200: { $ref: "MembershipInviteList#" }, ...errors },
      },
    },
    reviewController.listMembershipInvites,
  );

  router.delete(
    "/organizations/:slug/invites/:inviteId",
    {
      onRequest: metered(),
      schema: {
        operationId: "revokeOrganizationMembershipInvite",
        tags: ["review"],
        summary: "Revoke a pending organization membership invite",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["slug", "inviteId"],
          properties: {
            slug: { type: "string" },
            inviteId: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: { 200: { $ref: "MembershipInvite#" }, ...errors },
      },
    },
    reviewController.revokeMembershipInvite,
  );

  router.get(
    "/accounts",
    {
      onRequest: guard,
      schema: {
        operationId: "searchAccounts",
        tags: ["review"],
        summary: "Find accounts by handle, id, display name, email or provider subject",
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
        summary: "Find organizations, optionally filtered by verification",
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
