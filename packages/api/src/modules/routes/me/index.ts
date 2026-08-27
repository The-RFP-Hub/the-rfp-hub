/**
 * `/v1/me` — the authenticated account, its own entries, and its own duplicate queue.
 *
 * `GET /v1/me/opportunities/:id` exists because the PUBLIC detail route 404s a pending or rejected
 * entry, which is correct there and useless to the person who submitted it. This is the one route
 * that serves an owner their own non-public record.
 *
 * `PATCH /v1/me` is SESSION ONLY. Identity is not something a delegated credential changes: a
 * leaked key that could rewrite the account's handle could rewrite the attribution on everything
 * that account has ever published.
 */
import type { FastifyInstance } from "fastify";
import { meteredAuth } from "../shared/rate-limit-key.js";
import { meController } from "./me.controller.js";

export const me = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "getMe",
        tags: ["account"],
        summary: "The authenticated account, as resolved for this request",
        security: [{ bearerAuth: [] }],
        response: {
          200: { $ref: "Me#" },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.get,
  );

  router.patch(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      onRequest: meteredAuth(router, router.auth.requireSession, {
        max: 20,
        timeWindow: "1 minute",
      }),
      schema: {
        operationId: "updateMe",
        tags: ["account"],
        summary: "Update this account's public handle and display name (session only)",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            handle: {
              type: ["string", "null"],
              description:
                "The public identifier attribution uses: 3–40 lowercase alphanumerics separated by single hyphens.",
            },
            displayName: { type: ["string", "null"] },
          },
        },
        response: {
          200: { $ref: "Me#" },
          400: { $ref: "ErrorResponse#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          409: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.patch,
  );

  router.get(
    "/opportunities",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "listMyOpportunities",
        tags: ["account"],
        summary: "Entries this account submitted or publishes, whatever their review status",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Exact public id." },
            reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
            publisherStatus: {
              type: "string",
              enum: ["merged", "rejected", "pending", "hidden", "live"],
              description: "One derived publisher-facing listing state.",
            },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: { $ref: "ManagedOpportunityList#" },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.listOpportunities,
  );

  router.get(
    "/opportunities/:id",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "getMyOpportunity",
        tags: ["account"],
        summary: "One owned entry in full, including pending and rejected ones",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: { $ref: "Opportunity#" },
          401: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.findOpportunity,
  );

  router.get(
    "/duplicates",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "listMyDuplicates",
        tags: ["account"],
        summary: "Suspected duplicates against this account's entries",
        description:
          "Pairs are surfaced by the duplicate-detection pass. Each row names the account-owned side in `yourListing`; the existing top-level fields keep naming the other entry for compatibility with the published DuplicateMatch contract. An entry that has not been through detection — or a deployment with detection disabled — has none, and an empty list is that answer.",
        security: [{ bearerAuth: [] }],
        response: {
          200: { $ref: "OwnedDuplicateList#" },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.listDuplicates,
  );

  router.get(
    "/notifications",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "listMyNotifications",
        tags: ["account"],
        summary: "Notifications for this account, newest first",
        description:
          "Session and API-key principals receive the same account-scoped inbox. `unreadCount` covers the whole account independently of pagination and the optional unread filter.",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            unread: { type: "boolean" },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: { $ref: "NotificationList#" },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.listNotifications,
  );

  router.post(
    "/notifications/read-all",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "markAllMyNotificationsRead",
        tags: ["account"],
        summary: "Mark every unread notification for this account as read",
        security: [{ bearerAuth: [] }],
        response: {
          200: { $ref: "NotificationReadAll#" },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.markAllNotificationsRead,
  );

  router.post(
    "/notifications/:id/read",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "markMyNotificationRead",
        tags: ["account"],
        summary: "Mark one notification belonging to this account as read",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        },
        response: {
          200: { $ref: "Notification#" },
          401: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    meController.markNotificationRead,
  );
};
