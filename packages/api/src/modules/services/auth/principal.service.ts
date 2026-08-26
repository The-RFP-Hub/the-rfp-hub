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
import type { SessionService } from "./session.service.js";

/** The principal plus the row-level facts the routes need beyond authorization. */
export interface RequestPrincipal extends Principal {
  account: AccountRow;
  /** Which key acted, for `audit_log.actor_api_key_id`. Undefined for a session. */
  apiKeyId?: number;
  /**
   * The verified address this session belongs to — carried from the session lookup rather than
   * stored on `accounts`, so `/v1/me` serves it without a second query and there is one copy of it
   * in the system. Undefined for an API key, which identifies an account without a session.
   */
  email?: string | null;
}

export interface PrincipalDeps {
  accounts?: AccountService;
  keys?: ApiKeyService;
  sessions?: SessionService;
}

export class PrincipalService {
  readonly accounts: AccountService;
  readonly keys: ApiKeyService;
  readonly sessions: SessionService;

  constructor(db: DB = defaultDb, deps: PrincipalDeps = {}) {
    this.accounts = deps.accounts ?? new AccountService(db);
    this.keys = deps.keys ?? new ApiKeyService(db);
    if (!deps.sessions) {
      throw new Error("PrincipalService requires a SessionService (see plugins/auth.ts)");
    }
    this.sessions = deps.sessions;
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
    const verified = await this.sessions.verify(token);
    // One message for every way a token can fail to be a session — see `SessionService`.
    if (!verified) throw unauthorized("the session token could not be verified.");
    // JIT provisioning happens here, on the first `/v1` request an identity ever makes, rather than
    // in a database hook on user creation: an account is what this API decides about a person, and
    // it is created when they first act on it.
    // An email may redeem an invite only after Better-Auth says it is verified. For the primary
    // email-OTP path, the successful one-time code exchange is the proof of mailbox ownership.
    const account = await this.accounts.resolveBySubject(
      verified.subject,
      verified.emailVerified ? (verified.email ?? undefined) : undefined,
    );
    return this.assemble(account, "session", [], { email: verified.email });
  }

  private async assemble(
    account: AccountRow,
    credentialKind: "session" | "api_key",
    scopes: ApiKeyScope[],
    extra: { apiKeyId?: number; email?: string | null } = {},
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
