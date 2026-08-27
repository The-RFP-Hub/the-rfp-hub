/**
 * The WRITE surface for opportunities, in its own plugin under the same `/v1/opportunities` prefix.
 *
 * WHY A SEPARATE PLUGIN. `advertiseJsonLdContext` stamps the JSON-LD context `Link` header on
 * responses, and that header instructs a conformant processor to interpret the body THROUGH the
 * opportunity context. A submission result is an envelope, not an opportunity; a claim result is a
 * decision. Advertising either as linked-data opportunities would be wrong in a way no test of the
 * body could catch. Fastify encapsulation makes the plugin boundary the hook boundary, so these
 * routes cannot pick it up.
 *
 * WHY A PASS-THROUGH VALIDATOR. Fastify's ajv would reject a malformed body before the service ever
 * saw it and emit its own generic message, so the humanized, field-by-field report — the thing that
 * makes this endpoint usable — would never be produced. The pass-through is applied per-ROUTE
 * (`validatorCompiler` in each write route's options), scoped to `POST /` and `PUT /:id` only —
 * NOT plugin-wide — and each route still DECLARES `body: {$ref: "Opportunity#"}` so the published
 * document describes the request accurately. The schema is the contract; the service is the
 * enforcement point.
 *
 * `POST /:id/claim` is a different shape of request (`organizationSlug`, `note`) with nothing to
 * humanize, so it keeps Fastify's ordinary ajv validation against its own small schema below — a
 * malformed or missing claim body is a plain 400 before `ClaimService` ever sees it, rather than a
 * `.trim()` call on whatever the caller sent.
 */
import type { FastifyInstance } from "fastify";
import { meteredAuth } from "../shared/rate-limit-key.js";
import { submissionsController } from "./submissions.controller.js";

/** 256 KiB. A Standard document is a few kilobytes; this is the ceiling, not the expectation. */
export const SUBMISSION_BODY_LIMIT = 256 * 1024;

export const submissions = async (router: FastifyInstance): Promise<void> => {
  // Applied only to the two opportunity-write routes below (`validatorCompiler` in their own
  // route options), never plugin-wide: `POST /:id/claim` needs and keeps Fastify's own validation
  // against its declared schema.
  const passThroughValidator = () => (data: unknown) => ({ value: data });

  const writeSchema = {
    body: { $ref: "Opportunity#" },
    response: {
      200: { $ref: "SubmissionResult#" },
      201: { $ref: "SubmissionResult#" },
      400: { $ref: "ValidationErrorResponse#" },
      401: { $ref: "ErrorResponse#" },
      403: { $ref: "ErrorResponse#" },
      409: { $ref: "ErrorResponse#" },
      413: { $ref: "ErrorResponse#" },
    },
  };

  router.post(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      bodyLimit: SUBMISSION_BODY_LIMIT,
      onRequest: meteredAuth(router, router.auth.requireAuth, { max: 60, timeWindow: "1 minute" }),
      validatorCompiler: passThroughValidator,
      schema: {
        operationId: "createOpportunity",
        tags: ["submissions"],
        summary: "Submit an opportunity",
        description:
          "The body is a full RFP Hub Standard opportunity. The server sets every `source.*` attribution field itself. A submission auto-approves only when the credential may publish into the resolved namespace; otherwise it is stored `pending` and is invisible to the public reads. An identical repeat of an earlier create returns 200 with the original result.",
        security: [{ bearerAuth: [] }],
        ...writeSchema,
      },
    },
    submissionsController.create,
  );

  router.put(
    "/:id",
    {
      bodyLimit: SUBMISSION_BODY_LIMIT,
      onRequest: meteredAuth(router, router.auth.requireAuth, { max: 60, timeWindow: "1 minute" }),
      validatorCompiler: passThroughValidator,
      schema: {
        operationId: "replaceOpportunity",
        tags: ["submissions"],
        summary: "Replace an opportunity you own",
        description:
          "`body.id` must equal the path id: an id is immutable, never silently renamed.",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        ...writeSchema,
      },
    },
    submissionsController.replace,
  );

  router.post(
    "/:id/claim",
    {
      onRequest: meteredAuth(router, router.auth.requireAuth, { max: 60, timeWindow: "1 minute" }),
      schema: {
        operationId: "claimOpportunity",
        tags: ["submissions"],
        summary: "Claim publisher ownership of an entry on an organization's behalf",
        description:
          "Granted immediately (200) when the organization is verified AND appears among the entry's OPERATING organizations — sponsorship is not operation. Anything else is queued for review (202).",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["organizationSlug"],
          additionalProperties: false,
          properties: {
            organizationSlug: { type: "string" },
            note: { type: ["string", "null"] },
          },
        },
        response: {
          200: { $ref: "ClaimResult#" },
          202: { $ref: "ClaimResult#" },
          400: { $ref: "ErrorResponse#" },
          401: { $ref: "ErrorResponse#" },
          403: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
          409: { $ref: "ErrorResponse#" },
        },
      },
    },
    submissionsController.claim,
  );
};
