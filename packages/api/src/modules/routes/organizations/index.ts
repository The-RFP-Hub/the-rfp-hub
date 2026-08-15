/**
 * `PATCH /v1/organizations/:slug` — the OTHER authorised path to organisation metadata.
 *
 * D-9's rule has two halves and this is the second: a submission may CREATE a directory stub and may
 * never update one, so an organisation's own owner/admin needs a route through which to correct its
 * name, website and branding. Session only, and audited exactly like the reviewer's route.
 *
 * The verified flag is deliberately not editable here. An organisation verifying itself would make
 * the flag meaningless.
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
};
