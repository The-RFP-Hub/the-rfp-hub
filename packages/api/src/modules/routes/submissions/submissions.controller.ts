import type { FastifyReply, FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { ClaimService } from "../../services/claims/claim.service.js";
import {
  OpportunityWriteService,
  type WriteResult,
} from "../../services/opportunities/opportunity-write.service.js";
import type { ClaimResultView, SubmissionResultView } from "../../shared/api-views.js";
import { bodyOf, handled, paramsOf } from "../../shared/route-helpers.js";

const writes = new OpportunityWriteService();
const claims = new ClaimService();

function toView(result: WriteResult): SubmissionResultView {
  return {
    opportunity: result.opportunity,
    created: result.created,
    reviewStatus: result.reviewStatus,
    isListed: result.isListed,
    warnings: result.warnings,
  };
}

export const submissionsController = {
  create: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(request);
    const result = await writes.write(principal, request.body, { mode: "create" });
    // A recognised identical repeat is a 200 carrying the ORIGINAL result: the create already
    // happened, and reporting 201 a second time would claim a row was made that was not.
    return reply.code(result.repeated ? 200 : 201).send(toView(result));
  }),

  replace: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const result = await writes.write(principal, request.body, { mode: "replace", pathId: id });
    return reply.code(200).send(toView(result));
  }),

  claim: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const body = bodyOf<{ organizationSlug: string; note?: string | null }>(request);
    const result: ClaimResultView = await claims.claim(principal, id, body);
    // 202 for a queued claim — the request was accepted, the transfer has not happened yet.
    return reply.code(result.outcome === "queued" ? 202 : 200).send(result);
  }),
};
