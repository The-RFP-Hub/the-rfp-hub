/**
 * `PATCH /v1/organizations/:slug` — the OTHER authorised path to organisation metadata.
 *
 * D-9's rule has two halves and this is the second: a submission may CREATE a directory stub and may
 * never update one, so an organisation's own owner/admin needs a route through which to correct its
 * name, website and branding. Session only, and audited exactly like the reviewer's route.
 *
 * The verified flag is deliberately not editable here. An organisation verifying itself would make
 * the flag meaningless.
 *
 * `GET /:slug/opportunities` is the other half of an organisation's own view of itself: the entries
 * filed under its namespace, including the pending ones the public reads are pinned away from, and
 * `POST /:slug/opportunities/:id/{approve,reject}` is what a verified member does about one:
 * verified members decide within their own namespace, Hub reviewers decide anywhere. A rejection
 * requires a written reason — see the route's description for why that is the counterweight.
 */
import type { FastifyInstance } from "fastify";
import { organizationMetadataSchema } from "../review/index.js";
import { organizationsController } from "./organizations.controller.js";

export const organizations = async (router: FastifyInstance): Promise<void> => {
  router.patch(
    "/:slug",
    {
      onRequest: router.auth.requireSession,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        operationId: "updateOwnOrganization",
        tags: ["publishers"],
        summary: "Edit your own organisation's directory entry (owner or admin, session only)",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
        body: organizationMetadataSchema,
        response: {
          200: { $ref: "OrganizationSummary#" },
          400: { $ref: "ErrorResponse#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    organizationsController.patch,
  );

  router.get(
    "/:slug/opportunities",
    {
      // Either credential kind: a publishing key belongs to the account, and an organisation's own
      // dashboard is exactly the thing a key is for. The capability check below is what decides.
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "listOrganizationOpportunities",
        tags: ["publishers"],
        summary: "Entries published under this organisation, to its members, whatever their status",
        description:
          "Requires ANY membership on the organisation — verification governs publishing, not visibility. Scoped to the entries the organisation PUBLISHES (`source.publisher`), never the ones it merely sponsors.",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: { $ref: "ManagedOpportunityList#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    organizationsController.opportunities,
  );

  router.post(
    "/:slug/opportunities/:id/approve",
    {
      // SESSION ONLY. Approving publishes unreviewed content to the world, which is exactly the
      // power a leaked key must never hold — the same rule that keeps `publish` off a session's
      // behalf and out of `canManageKeys`.
      onRequest: router.auth.requireSession,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        operationId: "approveOrganizationOpportunity",
        tags: ["publishers"],
        summary: "Publish one of your organisation's own pending entries",
        description:
          "Requires a membership on the organisation while it is a VERIFIED publisher — the same trust event that makes a write auto-publish. Scoped to entries this organisation PUBLISHES (`source.publisher`); an entry under another namespace answers 404 rather than 403, so this cannot enumerate other organisations' queues. Verified members decide within their own namespace; Hub reviewers decide anywhere. The companion `reject` route requires a written reason.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["slug", "id"],
          properties: { slug: { type: "string" }, id: { type: "string" } },
        },
        response: {
          200: { $ref: "ReviewDecision#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
          409: { $ref: "ErrorResponse#" },
        },
      },
    },
    organizationsController.approve,
  );

  router.post(
    "/:slug/opportunities/:id/reject",
    {
      onRequest: router.auth.requireSession,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        operationId: "rejectOrganizationOpportunity",
        tags: ["publishers"],
        summary: "Refuse one of your organisation's own pending entries, with a reason",
        description:
          "The same guards as the approve route. `reason` is REQUIRED and is the counterweight to the obvious conflict of interest: anyone may submit an entry ABOUT an organisation, so a rejection here is attributed to the deciding member by handle — never coarsened to `reviewer` — and the reason is shown to whoever submitted it. An organisation may refuse things in its own namespace; it may not do so silently or anonymously. Hub reviewers remain able to decide anywhere.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["slug", "id"],
          properties: { slug: { type: "string" }, id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: 1 } },
        },
        response: {
          200: { $ref: "ReviewDecision#" },
          400: { $ref: "ErrorResponse#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
          409: { $ref: "ErrorResponse#" },
        },
      },
    },
    organizationsController.reject,
  );
};
