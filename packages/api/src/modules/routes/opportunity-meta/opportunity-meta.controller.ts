import type { FastifyRequest } from "fastify";
import { AuditService } from "../../services/audit/audit.service.js";
import { OpportunityMetaService } from "../../services/opportunities/opportunity-meta.service.js";
import type {
  AuditTrailView,
  DuplicateListView,
  VerificationRunView,
} from "../../shared/api-views.js";
import { notFound } from "../../shared/http-error.js";
import { handled, paramsOf } from "../../shared/route-helpers.js";

const meta = new OpportunityMetaService();
const audit = new AuditService();

export const opportunityMetaController = {
  audit: handled(async (request: FastifyRequest) => {
    const { id } = paramsOf<{ id: string }>(request);
    const scope = await meta.resolveForViewer(id, request.principal);
    const entries = await audit.list("opportunity", scope.row.id, { full: scope.privileged });
    return { entries } satisfies AuditTrailView;
  }),

  duplicates: handled(async (request: FastifyRequest) => {
    const { id } = paramsOf<{ id: string }>(request);
    const scope = await meta.resolveForViewer(id, request.principal);
    const items = await meta.duplicates(scope);
    return { items } satisfies DuplicateListView;
  }),

  verification: handled(async (request: FastifyRequest) => {
    const { id } = paramsOf<{ id: string }>(request);
    const scope = await meta.resolveForViewer(id, request.principal);
    const run = await meta.latestVerification(scope);
    if (!run) throw notFound(`${JSON.stringify(id)} has not been checked against its source yet.`);
    return run satisfies VerificationRunView;
  }),
};
