import { eq, getTableColumns, ilike, inArray, or } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { type AccountRow, type AuthUserRow, accounts, authUser } from "../../../db/schema.js";

/** The privileged directory projection. Email stays out of the public account row and `/v1/me`. */
export interface AccountSearchRow extends AccountRow {
  email: string | null;
}

export interface AccountRecipientRow {
  accountId: number;
  email: string | null;
}

export type AuthIdentity = Pick<AuthUserRow, "id" | "email" | "emailVerified">;

export type AccountUpdate = Partial<
  Pick<AccountRow, "directCreate" | "displayName" | "globalRole" | "handle" | "updatedAt">
>;

export class AccountRepository {
  constructor(private readonly exec: DbLike) {}

  /** The identity behind an address, or nothing. Better-Auth stores addresses lower-cased. */
  async identityByEmail(address: string): Promise<AuthIdentity | undefined> {
    const rows = await this.exec
      .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified })
      .from(authUser)
      .where(eq(authUser.email, address.trim().toLowerCase()))
      .limit(1);
    return rows[0];
  }

  /** The identity an opaque authentication subject names, or nothing. */
  async identityBySubject(subject: string): Promise<AuthIdentity | undefined> {
    const rows = await this.exec
      .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified })
      .from(authUser)
      .where(eq(authUser.id, subject))
      .limit(1);
    return rows[0];
  }

  async insertBySubject(subject: string): Promise<void> {
    await this.exec.insert(accounts).values({ authUserId: subject }).onConflictDoNothing();
  }

  async findBySubject(subject: string): Promise<AccountRow | undefined> {
    const rows = await this.exec
      .select()
      .from(accounts)
      .where(eq(accounts.authUserId, subject))
      .limit(1);
    return rows[0];
  }

  async lockBySubject(subject: string): Promise<AccountRow | undefined> {
    const rows = await this.exec
      .select()
      .from(accounts)
      .where(eq(accounts.authUserId, subject))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async findById(id: number): Promise<AccountRow | undefined> {
    const rows = await this.exec.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return rows[0];
  }

  async lockById(id: number): Promise<AccountRow | undefined> {
    const rows = await this.exec
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .for("update")
      .limit(1);
    return rows[0];
  }

  async lockAdmins(): Promise<{ id: number }[]> {
    return this.exec
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.globalRole, "admin"))
      .orderBy(accounts.id)
      .for("update");
  }

  async update(id: number, set: AccountUpdate): Promise<AccountRow | undefined> {
    const rows = await this.exec.update(accounts).set(set).where(eq(accounts.id, id)).returning();
    return rows[0];
  }

  /** T3 account discovery for staff screens. Email is joined only for this privileged read. */
  async search(q: string | undefined, limit = 25): Promise<AccountSearchRow[]> {
    const query = (q ?? "").trim();
    const select = () =>
      this.exec
        .select({ ...getTableColumns(accounts), email: authUser.email })
        .from(accounts)
        .leftJoin(authUser, eq(authUser.id, accounts.authUserId));
    if (query === "") {
      return select().orderBy(accounts.id).limit(limit);
    }
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const prefix = `${query.replace(/[\\%_]/g, "\\$&")}%`;
    const accountId = /^\d+$/.test(query) ? Number(query) : Number.NaN;
    const match = or(
      ilike(accounts.handle, like),
      ilike(accounts.displayName, like),
      eq(accounts.authUserId, query),
      ilike(authUser.email, prefix),
      Number.isSafeInteger(accountId) ? eq(accounts.id, accountId) : undefined,
    );
    return select().where(match).orderBy(accounts.id).limit(limit);
  }

  /** Delivery address projection. Authentication identity data stays behind this repository. */
  async notificationRecipients(accountIds: number[]): Promise<AccountRecipientRow[]> {
    if (accountIds.length === 0) return [];
    return this.exec
      .select({ accountId: accounts.id, email: authUser.email })
      .from(accounts)
      .leftJoin(authUser, eq(accounts.authUserId, authUser.id))
      .where(inArray(accounts.id, accountIds));
  }
}
