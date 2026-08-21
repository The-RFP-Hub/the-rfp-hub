import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRow } from "../../../db/schema.js";
import { principalOf } from "../../../plugins/auth.js";
import { ApiKeyService } from "../../services/auth/api-key.service.js";
import type { ApiKeyCreatedView, ApiKeyListView, ApiKeyView } from "../../shared/api-views.js";
import { bodyOf, handled, idParam, paramsOf } from "../../shared/route-helpers.js";

const keysService = new ApiKeyService();

/** The row minus its hash. The hash is not a secret, but it is not anybody's business either. */
function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export const keysController = {
  list: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const rows = await keysService.list(principal.accountId);
    return { items: rows.map(toView) } satisfies ApiKeyListView;
  }),

  create: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(request);
    const body = bodyOf<{ name?: string | null; scopes?: string[]; expiresAt?: string | null }>(
      request,
    );
    const minted = await keysService.create(principal.accountId, body);
    const view: ApiKeyCreatedView = { key: toView(minted.key), token: minted.token };
    return reply.code(201).send(view);
  }),

  revoke: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const row = await keysService.revoke(principal.accountId, idParam(id, "api key"));
    return toView(row);
  }),
};
