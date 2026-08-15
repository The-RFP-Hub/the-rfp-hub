/**
 * API keys: minted once, hashed, soft-revoked, and account-scoped at every turn.
 *
 * The token format and the reason it is a plain SHA-256 rather than a KDF live in
 * `modules/shared/api-key-token.ts`. What lives here is the lifecycle, and three of its rules are
 * load-bearing:
 *
 * 1. **The secret is returned exactly once.** `create()` is the only place a full token exists;
 *    `list()` returns prefixes. A lost key is replaced, never recovered.
 * 2. **Every read and write is `WHERE account_id = $mine`.** A key id belonging to somebody else is
 *    a 404, not a 403 — a 403 would confirm the id exists, which is an existence oracle over other
 *    people's credentials.
 * 3. **Revocation is soft.** `audit_log.actor_api_key_id` points at keys, and a hard delete would
 *    leave the history unable to answer the one question soft revocation exists for: which key did
 *    this.
 *
 * `last_used_at` is written at most once per five minutes per key, fire-and-forget. It exists so a
 * human can spot a key nobody uses; writing it on every request would put a write on the hot path
 * of a read-only API for a field whose value nobody reads to the minute.
 */
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, type ApiKeyRow, accounts, apiKeys } from "../../../db/schema.js";
import { mintApiKey, parseApiKey } from "../../shared/api-key-token.js";
import type { ApiKeyScope } from "../../shared/capabilities.js";
import { badRequest, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";

/** How stale `last_used_at` may get before a request bothers to refresh it. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

const VALID_SCOPES: ApiKeyScope[] = ["read", "write", "publish"];
const NAME_MAX = 80;
const MAX_KEYS_PER_ACCOUNT = 25;

export interface CreateKeyInput {
  name?: string | null;
  scopes?: string[];
  expiresAt?: string | null;
}

export interface MintedKey {
  key: ApiKeyRow;
  /** The full token. The ONLY time it exists; not stored, not logged, not recoverable. */
  token: string;
}

/** What a presented key resolved to. */
export interface VerifiedKey {
  key: ApiKeyRow;
  account: AccountRow;
}

export class ApiKeyService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  /** This account's keys, newest first. Revoked keys are included and say so. */
  async list(accountId: number): Promise<ApiKeyRow[]> {
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  }

  async create(accountId: number, input: CreateKeyInput): Promise<MintedKey> {
    const scopes = normalizeScopes(input.scopes);
    const name = normalizeName(input.name);
    const expiresAt = normalizeExpiry(input.expiresAt);

    const live = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)));
    if (live.length >= MAX_KEYS_PER_ACCOUNT) {
      throw badRequest(
        "too_many_keys",
        `an account may hold at most ${MAX_KEYS_PER_ACCOUNT} live keys; revoke one before minting another.`,
      );
    }

    const minted = mintApiKey();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(apiKeys)
        .values({
          accountId,
          name,
          keyPrefix: minted.prefix,
          keyHash: minted.keyHash,
          scopes,
          expiresAt,
        })
        .returning();
      const key = rows[0];
      if (!key) throw new Error("failed to mint an api key");
      await this.audit.record(tx, {
        subjectKind: "api_key",
        subjectId: key.id,
        actorKind: "user",
        actorAccountId: accountId,
        action: "create_api_key",
        // The prefix, never the secret: an audit row is a place a token must not be recoverable
        // from, and the prefix is exactly the identifier that exists for naming a key without it.
        patch: { keyPrefix: key.keyPrefix, scopes: key.scopes, name: key.name },
      });
      return { key, token: minted.token };
    });
  }

  /**
   * Soft-revoke one of THIS account's keys.
   *
   * Returns the row, or throws 404 — including when the id exists but belongs to somebody else.
   * Re-revoking an already-revoked key is a no-op that still returns it, so a retried request from
   * a flaky client is not an error.
   */
  async revoke(accountId: number, keyId: number): Promise<ApiKeyRow> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
        .limit(1);
      const key = existing[0];
      if (!key) throw notFound(`no api key ${keyId}.`);
      if (key.revokedAt !== null) return key;

      const updated = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
        .returning();
      const row = updated[0] ?? key;
      await this.audit.record(tx, {
        subjectKind: "api_key",
        subjectId: row.id,
        actorKind: "user",
        actorAccountId: accountId,
        action: "revoke_api_key",
        patch: { keyPrefix: row.keyPrefix, revokedAt: { before: null, after: row.revokedAt } },
      });
      return row;
    });
  }

  /**
   * Resolve a presented token, or return undefined.
   *
   * Undefined for every failure — malformed, unknown, revoked, expired — because the caller turns
   * all four into the same 401 and telling them apart tells a prober which keys exist.
   */
  async verify(token: string): Promise<VerifiedKey | undefined> {
    const parsed = parseApiKey(token);
    if (!parsed) return undefined;

    const rows = await this.db
      .select({ key: apiKeys, account: accounts })
      .from(apiKeys)
      .innerJoin(accounts, eq(accounts.id, apiKeys.accountId))
      .where(eq(apiKeys.keyHash, parsed.keyHash))
      .limit(1);
    const found = rows[0];
    if (!found) return undefined;
    if (found.key.revokedAt !== null) return undefined;
    if (found.key.expiresAt !== null && found.key.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    return found;
  }

  /**
   * Refresh `last_used_at`, at most once per throttle window, and never blocking the request.
   *
   * The staleness test is in the SQL predicate rather than in the process, so two concurrent
   * requests do not both decide to write: the second one's `WHERE` no longer matches.
   */
  touchLastUsed(keyId: number, now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(eq(apiKeys.id, keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff))),
      )
      .catch(() => {
        // Best-effort by design: a failed bookkeeping write must never fail the request it was
        // observing. Nothing reads this field on a decision path.
      });
  }
}

/** Only the three documented scopes, deduplicated; `read` is the default and the floor. */
export function normalizeScopes(raw: string[] | undefined): ApiKeyScope[] {
  if (raw === undefined) return ["read"];
  const seen = new Set<ApiKeyScope>();
  for (const value of raw) {
    const scope = String(value).trim().toLowerCase();
    if (!(VALID_SCOPES as string[]).includes(scope)) {
      throw badRequest(
        "invalid_scope",
        `\`scopes\` may contain only ${VALID_SCOPES.join(", ")}; got ${JSON.stringify(value)}.`,
      );
    }
    seen.add(scope as ApiKeyScope);
  }
  // A key with no scope can do nothing, which is a key nobody meant to mint.
  if (seen.size === 0) seen.add("read");
  // `read` is implied by both stronger scopes but is stored explicitly so a row states its own
  // rights in full rather than requiring the reader to know the implication.
  seen.add("read");
  return VALID_SCOPES.filter((scope) => seen.has(scope));
}

function normalizeName(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const name = raw.trim();
  if (name === "") return null;
  if (name.length > NAME_MAX) {
    throw badRequest("invalid_name", `\`name\` must be at most ${NAME_MAX} characters.`);
  }
  return name;
}

function normalizeExpiry(raw: string | null | undefined): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw badRequest("invalid_expiry", "`expiresAt` must be an ISO 8601 instant.");
  }
  if (at.getTime() <= Date.now()) {
    throw badRequest("invalid_expiry", "`expiresAt` must be in the future.");
  }
  return at;
}
