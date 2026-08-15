/**
 * One bearer value → one principal, with the credential KIND preserved all the way through.
 *
 * `Authorization: Bearer …` carries either kind of credential, and which one it is decides real
 * authority: a session may manage keys, change identity, review and administer; an API key may not,
 * whatever role its owner holds. The discrimination is made on the TOKEN ITSELF (`rfph_` prefix,
 * see `modules/shared/api-key-token.ts`) rather than on a header the caller chooses, so a caller
 * cannot present a key and have it treated as a session.
 *
 * The resolved `Principal` is exactly the input `effectiveCaps()` takes — role, direct-create,
 * scopes, memberships — and nothing downstream re-derives any of it.
 */
import type { DB } from "../../../db/client.js";
import { db as defaultDb } from "../../../db/client.js";
import type { AccountRow } from "../../../db/schema.js";
import { isApiKeyToken } from "../../shared/api-key-token.js";
import type { ApiKeyScope, Principal } from "../../shared/capabilities.js";
import { unauthorized } from "../../shared/http-error.js";
import { AccountService } from "./account.service.js";
import { ApiKeyService } from "./api-key.service.js";
import type { PrivyTokenService } from "./privy-token.service.js";

/** The principal plus the row-level facts the routes need beyond authorization. */
export interface RequestPrincipal extends Principal {
  account: AccountRow;
  /** Which key acted, for `audit_log.actor_api_key_id`. Undefined for a session. */
  apiKeyId?: number;
}

export interface PrincipalDeps {
  accounts?: AccountService;
  keys?: ApiKeyService;
  privy?: PrivyTokenService;
}

export class PrincipalService {
  readonly accounts: AccountService;
  readonly keys: ApiKeyService;
  readonly privy: PrivyTokenService;

  constructor(db: DB = defaultDb, deps: PrincipalDeps = {}) {
    this.accounts = deps.accounts ?? new AccountService(db);
    this.keys = deps.keys ?? new ApiKeyService(db);
    if (!deps.privy) {
      throw new Error("PrincipalService requires a PrivyTokenService (see plugins/auth.ts)");
    }
    this.privy = deps.privy;
  }

  /** Resolve a bearer value, or throw the 401/403 it deserves. */
  async fromBearer(token: string): Promise<RequestPrincipal> {
    return isApiKeyToken(token) ? this.fromApiKey(token) : this.fromSession(token);
  }

  private async fromApiKey(token: string): Promise<RequestPrincipal> {
    const verified = await this.keys.verify(token);
    if (!verified) throw unauthorized("the api key is unknown, revoked or expired.");
    this.keys.touchLastUsed(verified.key.id);
    return this.assemble(verified.account, "api_key", verified.key.scopes as ApiKeyScope[], {
      apiKeyId: verified.key.id,
    });
  }

  private async fromSession(token: string): Promise<RequestPrincipal> {
    const claims = await this.privy.verify(token);
    // JIT provisioning AND the bootstrap-admin re-evaluation both happen here, on every login.
    const account = await this.accounts.resolveByPrivyDid(claims.did);
    return this.assemble(account, "session", []);
  }

  private async assemble(
    account: AccountRow,
    credentialKind: "session" | "api_key",
    scopes: ApiKeyScope[],
    extra: { apiKeyId?: number } = {},
  ): Promise<RequestPrincipal> {
    const memberships = await this.accounts.memberships(account.id);
    return {
      accountId: account.id,
      credentialKind,
      role: account.globalRole,
      directCreate: account.directCreate,
      scopes,
      memberships,
      account,
      ...extra,
    };
  }
}
