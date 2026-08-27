import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { AdminService } from "../../services/admin/admin.service.js";
import { JOB_NAMES } from "../../services/jobs/registry.js";
import { UnknownJobError, runJob } from "../../services/jobs/runner.js";
import { VerificationService } from "../../services/verification/verification.service.js";
import { notFound } from "../../shared/http-error.js";
import { bodyOf, handled, idParam, paramsOf } from "../../shared/route-helpers.js";

const admins = new AdminService();
const verification = new VerificationService();

export const adminController = {
  assignRole: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { role } = bodyOf<{ role: string }>(request);
    return admins.assignRole(principal.accountId, idParam(id, "account"), role);
  }),

  setDirectCreate: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { directCreate } = bodyOf<{ directCreate: boolean }>(request);
    return admins.setDirectCreate(principal.accountId, idParam(id, "account"), directCreate);
  }),

  verifySource: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const row = await verification.resolvePublicId(id);
    return verification.verify(row.id, {
      actorKind: "user",
      actorAccountId: principal.accountId,
    });
  }),

  /**
   * ONE pass, deliberately, and an INTERACTIVE one. This is a button in a dashboard, not the
   * schedule: a request that looped a cursor job to exhaustion would hold a connection and an HTTP
   * socket for as long as the backlog took, and the thing that IS allowed to take that long is the
   * container task.
   *
   * `interactive: true` is the second half of that same rule, and it is needed because one pass is
   * not by itself a bound. `verification-backfill` paces its fetches per host, so its scheduled
   * selection is minutes of wall clock in ONE pass — a request nobody's proxy will wait for. The
   * flag makes an unnamed `limit` fall back to the job's `interactiveLimit` instead
   * (`jobs/registry.ts`); a caller that names a limit still gets exactly what it asked for.
   */
  runJob: handled(async (request: FastifyRequest) => {
    const { job } = paramsOf<{ job: string }>(request);
    const { limit } = bodyOf<{ limit?: number }>(request);
    try {
      return await runJob(job, { limit, maxPasses: 1, interactive: true });
    } catch (error) {
      if (error instanceof UnknownJobError) {
        throw notFound(`no job ${JSON.stringify(job)}. Known jobs: ${JOB_NAMES.join(", ")}.`);
      }
      throw error;
    }
  }),
};
