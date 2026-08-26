import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type AccountRow,
  type ApiKeyInsert,
  type ApiKeyRow,
  accounts,
  apiKeys,
} from "../../../db/schema.js";

export interface VerifiedApiKeyRecord {
  key: ApiKeyRow;
  account: AccountRow;
}

export class ApiKeyRepository {
  constructor(private readonly exec: DbLike) {}

  async listForAccount(accountId: number): Promise<ApiKeyRow[]> {
    return this.exec
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  }

  async lockAccount(accountId: number): Promise<void> {
    await this.exec
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
  }

  async listLiveForAccount(accountId: number): Promise<{ id: number }[]> {
    return this.exec
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)));
  }

  async create(input: ApiKeyInsert): Promise<ApiKeyRow | undefined> {
    const rows = await this.exec.insert(apiKeys).values(input).returning();
    return rows[0];
  }

  async findForAccount(accountId: number, keyId: number): Promise<ApiKeyRow | undefined> {
    const rows = await this.exec
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
      .limit(1);
    return rows[0];
  }

  async revokeIfLive(
    accountId: number,
    keyId: number,
    revokedAt: Date,
  ): Promise<ApiKeyRow | undefined> {
    const rows = await this.exec
      .update(apiKeys)
      .set({ revokedAt })
      .where(
        and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)),
      )
      .returning();
    return rows[0];
  }

  async findByHash(keyHash: string): Promise<VerifiedApiKeyRecord | undefined> {
    const rows = await this.exec
      .select({ key: apiKeys, account: accounts })
      .from(apiKeys)
      .innerJoin(accounts, eq(accounts.id, apiKeys.accountId))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    return rows[0];
  }

  async touchLastUsed(keyId: number, lastUsedAt: Date, cutoff: Date): Promise<void> {
    await this.exec
      .update(apiKeys)
      .set({ lastUsedAt })
      .where(
        and(eq(apiKeys.id, keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff))),
      );
  }
}
