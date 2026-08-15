/**
 * The read-only sub-resources of one entry: its audit trail, its duplicate pairs, its last
 * verification run.
 *
 * A separate plugin for the same reason `routes/submissions` is one: none of these bodies is a
 * Standard opportunity, so none of them may carry the JSON-LD context `Link` header that tells a
 * processor to read it as one.
 *
 * Authentication is OPTIONAL on all three. The audit trail of a public entry is public — coarsened,
 * but public — and requiring a credential to read the history of a published listing would make the
 * transparency conditional on having an account. What a credential changes is how much is shown.
 */
import type { FastifyInstance } from "fastify";
import { opportunityMetaController } from "./opportunity-meta.controller.js";

export const opportunityMeta = async (router: FastifyInstance): Promise<void> => {
  const idParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Public id, e.g. fundingmap:1459" } },
  };

  router.get(
    "/:id/audit",
    {
      onRequest: router.auth.optionalAuth,
      schema: {
        operationId: "getOpportunityAudit",
        tags: ["opportunities"],
        summary: "The mutation history of one entry",
        description:
          "Public callers see the changed field NAMES and a coarse actor. The entry's submitter, its publisher and reviewers additionally see the full `patch`. A non-public entry 404s for everyone else, matching the detail route.",
        params: idParams,
        response: {
          200: { $ref: "AuditTrail#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityMetaController.audit,
  );

  router.get(
    "/:id/duplicates",
    {
      onRequest: router.auth.optionalAuth,
      schema: {
        operationId: "getOpportunityDuplicates",
        tags: ["opportunities"],
        summary: "Duplicate pairs naming this entry",
        description:
          "An unprivileged caller is only ever shown pairs whose other side is publicly visible. An entry that has not been through duplicate detection has none, and an empty list is that answer.",
        params: idParams,
        response: {
          200: { $ref: "DuplicateList#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityMetaController.duplicates,
  );

  router.get(
    "/:id/verification",
    {
      onRequest: router.auth.optionalAuth,
      schema: {
        operationId: "getOpportunityVerification",
        tags: ["opportunities"],
        summary: "The most recent source check of this entry",
        description:
          "404 when the entry has never been checked — which is a real state, not an error. `matched` is a low-bar anti-spam signal, not a fact-check.",
        params: idParams,
        response: {
          200: { $ref: "VerificationRun#" },
          404: { $ref: "ErrorResponse#" },
        },
      },
    },
    opportunityMetaController.verification,
  );
};
