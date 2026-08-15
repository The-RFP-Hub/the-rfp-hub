/**
 * `/v1/admin` — the T4 surface: global roles and the direct-create grant.
 *
 * `requireRole("admin")` is session-only, like every editorial gate: an API key belonging to an
 * admin must not be able to grant itself, or anyone else, a role.
 *
 * The job-run convenience endpoint belongs on this prefix and arrives with the jobs it would run.
 * It is a convenience only — the schedule starts jobs as one-off container tasks with the
 * deployment's own credentials, never through a public endpoint.
 */
import type { FastifyInstance } from "fastify";
import { adminController } from "./admin.controller.js";

export const admin = async (router: FastifyInstance): Promise<void> => {
  const guard = router.auth.requireRole("admin");
  const accountParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9]+$" } },
  };
  const errors = {
    400: { $ref: "ErrorResponse#" },
    401: { $ref: "ErrorResponse#" },
    403: { $ref: "ErrorResponse#" },
    404: { $ref: "ErrorResponse#" },
  };

  router.post(
    "/accounts/:id/role",
    {
      onRequest: guard,
      schema: {
        operationId: "assignAccountRole",
        tags: ["admin"],
        summary: "Set an account's global role",
        security: [{ bearerAuth: [] }],
        params: accountParams,
        body: {
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: { role: { type: "string", enum: ["submitter", "reviewer", "admin"] } },
        },
        response: { 200: { $ref: "AccountSummary#" }, ...errors },
      },
    },
    adminController.assignRole,
  );

  router.post(
    "/accounts/:id/direct-create",
    {
      onRequest: guard,
      schema: {
        operationId: "setAccountDirectCreate",
        tags: ["admin"],
        summary: "Grant or revoke publishing into any namespace without a membership",
        description:
          "Independent of the global role: reviewing is not publishing. It never elevates an API key either — a `write`-only key on a direct-create account still lands its submissions pending.",
        security: [{ bearerAuth: [] }],
        params: accountParams,
        body: {
          type: "object",
          required: ["directCreate"],
          additionalProperties: false,
          properties: { directCreate: { type: "boolean" } },
        },
        response: { 200: { $ref: "AccountSummary#" }, ...errors },
      },
    },
    adminController.setDirectCreate,
  );
};
