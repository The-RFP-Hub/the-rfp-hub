import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { toStandard } from "../../mappers/opportunity.mapper.js";
import { AccountService } from "../../services/auth/account.service.js";
import { ManagedOpportunityService } from "../../services/opportunities/managed-opportunity.service.js";
import { OpportunityMetaService } from "../../services/opportunities/opportunity-meta.service.js";
import type {
  DuplicateListView,
  ManagedOpportunityListView,
  MeView,
} from "../../shared/api-views.js";
import { effectiveCaps } from "../../shared/capabilities.js";
import { notFound } from "../../shared/http-error.js";
import { bodyOf, handled, paramsOf, queryOf } from "../../shared/route-helpers.js";

const accountsService = new AccountService();
const managed = new ManagedOpportunityService();
const meta = new OpportunityMetaService();

async function view(request: FastifyRequest): Promise<MeView> {
  const principal = principalOf(request);
  const memberships = await accountsService.membershipsDetailed(principal.accountId);
  // No namespace: `/v1/me` is an account-scoped surface, so the per-namespace answers do not apply
  // and `effectiveCaps` returns false for them by construction.
  const caps = effectiveCaps(principal);
  return {
    accountId: principal.accountId,
    handle: principal.account.handle,
    displayName: principal.account.displayName,
    email: principal.account.email,
    primaryWallet: principal.account.primaryWallet,
    role: principal.role,
    directCreate: principal.directCreate,
    credentialKind: principal.credentialKind,
    scopes: principal.scopes,
    memberships: memberships.map((m) => ({
      slug: m.slug,
      name: m.name,
      role: m.role,
      verified: m.verified,
    })),
    canManageKeys: caps.canManageKeys,
    canReview: caps.canReview,
    canAdmin: caps.canAdmin,
    createdAt: principal.account.createdAt.toISOString(),
  };
}

export const meController = {
  get: handled(async (request: FastifyRequest) => view(request)),

  patch: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const body = bodyOf<{ handle?: string | null; displayName?: string | null }>(request);
    const updated = await accountsService.updateProfile(principal.accountId, {
      ...(body.handle !== undefined ? { handle: body.handle } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    });
    // The refreshed row, so the response reflects the write rather than the pre-request snapshot.
    request.principal = { ...principal, account: updated };
    return view(request);
  }),

  listOpportunities: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const query = queryOf<{
      reviewStatus?: "pending" | "approved" | "rejected";
      page?: number;
      limit?: number;
    }>(request);
    const page = await managed.listOwned(principal, query);
    return page satisfies ManagedOpportunityListView;
  }),

  findOpportunity: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const row = await managed.findOwned(principal, id);
    if (!row) throw notFound(`no opportunity ${JSON.stringify(id)} of yours.`);
    return toStandard(row);
  }),

  listDuplicates: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const items = await meta.duplicatesForOwner(principal);
    return { items } satisfies DuplicateListView;
  }),
};
