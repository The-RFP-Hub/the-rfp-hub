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
import { JOB_NAMES } from "../../services/jobs/registry.js";
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
        description:
          "Includes `admin`: administrators are granted and revoked in the product. The LAST remaining admin cannot be demoted here (409 `last_admin`) — that state is recoverable only by an operator running the grant-admin script against the database. An account with no identity behind it cannot be granted anything (409 `unreachable_account`); it can still be demoted.",
        security: [{ bearerAuth: [] }],
        params: accountParams,
        body: {
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: { role: { type: "string", enum: ["submitter", "reviewer", "admin"] } },
        },
        response: {
          200: { $ref: "AccountSummary#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
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
          "Independent of the global role: reviewing is not publishing. It never elevates an API key either — a `write`-only key on a direct-create account still lands its submissions pending. An account with no identity behind it cannot be granted it (409 `unreachable_account`).",
        security: [{ bearerAuth: [] }],
        params: accountParams,
        body: {
          type: "object",
          required: ["directCreate"],
          additionalProperties: false,
          properties: { directCreate: { type: "boolean" } },
        },
        response: {
          200: { $ref: "AccountSummary#" },
          409: { $ref: "ErrorResponse#" },
          ...errors,
        },
      },
    },
    adminController.setDirectCreate,
  );

  router.post(
    "/opportunities/:id/verify",
    {
      onRequest: guard,
      schema: {
        operationId: "adminVerifyOpportunitySource",
        tags: ["admin"],
        summary: "Fetch this entry's applicationUrl now (administrative / bulk use)",
        description:
          "The same action `/v1/review/opportunities/{id}/verify` performs, on the administrator prefix — kept for bulk and scripted runs over many entries. Triggering a single verification is a REVIEWER capability, and the review route is where an interactive reviewer does it.",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: { $ref: "VerificationRun#" }, ...errors },
      },
    },
    adminController.verifySource,
  );

  router.post(
    "/jobs/:job/run",
    {
      onRequest: guard,
      schema: {
        operationId: "runMaintenanceJob",
        tags: ["admin"],
        summary: "Start one scheduled maintenance job now",
        description: `A CONVENIENCE, NOT THE SCHEDULE. Scheduled runs start each job as a one-off container task with the deployment's own credentials (\`node packages/api/dist/jobs.js <job>\`); this route exists so a reviewer can kick one from the dashboard without shell access, and it is a signed-in administrator session only — never a machine credential. It runs ONE pass: a full catch-up is what the task runner is for.\n\nEvery job takes a database advisory lock on its own name, so calling this while the scheduled run is in flight answers \`skipped: "locked"\` rather than doing the work twice.\n\nJobs: ${JOB_NAMES.join(", ")}. See packages/api/docs/jobs.md.`,
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["job"],
          properties: { job: { type: "string", enum: JOB_NAMES } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              description: "Bound on the rows one pass touches. Cursor jobs only.",
            },
          },
        },
        response: { 200: { $ref: "JobRunResult#" }, ...errors },
      },
    },
    adminController.runJob,
  );
};
