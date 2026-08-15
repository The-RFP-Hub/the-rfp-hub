import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { AdminService } from "../../services/admin/admin.service.js";
import { VerificationService } from "../../services/verification/verification.service.js";
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
};
