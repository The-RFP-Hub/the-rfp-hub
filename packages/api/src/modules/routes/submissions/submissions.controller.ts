/**
 * The write surface's controller — and the one place the post-commit work is wired in.
 *
 * The order inside the hook is deliberate. The verification enqueue is started FIRST and not
 * awaited: it is genuinely fire-and-forget, and starting it after an awaited call would mean a
 * duplicate-check failure took it down too (the whole hook is wrapped in one `try`). The duplicate
 * check IS awaited, because `duplicateCheck` and the suspected matches belong in the 201 body — a
 * result computed after the reply is a result nobody sees. It is bounded by `EMBEDDING_TIMEOUT_MS`
 * inside the dedupe service, and it never throws for a provider failure.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../../config.js";
import { principalOf } from "../../../plugins/auth.js";
import { ClaimService } from "../../services/claims/claim.service.js";
import { DedupeService } from "../../services/dedupe/dedupe.service.js";
import {
  OpportunityWriteService,
  type WriteResult,
} from "../../services/opportunities/opportunity-write.service.js";
import { VerificationService } from "../../services/verification/verification.service.js";
import type { ClaimResultView, SubmissionResultView } from "../../shared/api-views.js";
import { bodyOf, handled, paramsOf } from "../../shared/route-helpers.js";

const dedupe = new DedupeService();
const verification = new VerificationService();
const claims = new ClaimService();

const writes = new OpportunityWriteService(undefined, {
  async afterCommit(event) {
    if (config.verification.onSubmit) verification.enqueue(event.opportunityId);
    // Always the PUBLIC candidate scope, whoever submitted: a suspected-match response must never
    // disclose another account's pending or unlisted title and id, and a reviewer submitting an
    // entry is still submitting an entry.
    return { duplicateCheck: await dedupe.check(event.opportunityId, "public") };
  },
});

function toView(result: WriteResult): SubmissionResultView {
  // Absent means the hook itself failed, which is exactly `unavailable`: nothing was checked, and
  // the backfill job still owes this entry a pass.
  const check = result.duplicateCheck ?? { status: "unavailable" as const, duplicates: [] };
  return {
    opportunity: result.opportunity,
    created: result.created,
    reviewStatus: result.reviewStatus,
    isListed: result.isListed,
    warnings: result.warnings,
    duplicateCheck: check.status,
    duplicates: check.duplicates,
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
