/**
 * `/v1/keys` — mint, list and revoke this account's API keys.
 *
 * EVERY ROUTE HERE IS SESSION ONLY, and that is the point: an API key that could mint another key
 * could mint a stronger one, which would make every scope decision advisory. `requireSession`
 * refuses a key with 403 before the handler runs.
 *
 * Every row is additionally scoped to `account_id = mine`, and a key id belonging to somebody else
 * is a 404 rather than a 403 — a 403 would be an existence oracle over other people's credentials.
 *
 * Rotation is create-then-revoke, which overlaps by construction: mint the new key, deploy it,
 * revoke the old one. There is no rotate endpoint because there is nothing for it to do that those
 * two calls do not already do, in an order the caller controls.
 */
import type { FastifyInstance } from "fastify";
import { keysController } from "./keys.controller.js";

export const keys = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      onRequest: router.auth.requireSession,
      schema: {
        operationId: "listApiKeys",
        tags: ["auth"],
        summary: "This account's API keys, without their secrets (session only)",
        security: [{ bearerAuth: [] }],
        response: {
          200: { $ref: "ApiKeyList#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
        },
      },
    },
    keysController.list,
  );

  router.post(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      onRequest: router.auth.requireSession,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        operationId: "createApiKey",
        tags: ["auth"],
        summary: "Mint an API key — the secret is returned exactly once (session only)",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: ["string", "null"], description: "A label, for your own bookkeeping." },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["read", "write", "publish"] },
              description:
                "`publish` is strictly stronger than `write` and is required for ANY path that causes immediate publication — including on an account that could otherwise publish.",
            },
            expiresAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        response: {
          201: { $ref: "ApiKeyCreated#" },
          400: { $ref: "ErrorResponse#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
        },
      },
    },
    keysController.create,
  );

  router.delete(
    "/:id",
    {
      onRequest: router.auth.requireSession,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        operationId: "revokeApiKey",
        tags: ["auth"],
        summary: "Revoke one of this account's keys (session only)",
        description:
          "Revocation is soft, so audit rows naming the key keep resolving. A key id that belongs to another account is a 404.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        },
        response: {
          200: { $ref: "ApiKey#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    keysController.revoke,
  );
};
