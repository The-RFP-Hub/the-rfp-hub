/**
 * Accounts: provisioned on first login, keyed on the identity provider's DID, and nothing else.
 *
 * WHY THE DID AND NOT A WALLET. A wallet address that reaches this API arrived in a request, which
 * makes it self-asserted, which makes it a forgeable authorization input. The DID comes out of a
 * signature this process verified. `accounts.primary_wallet` exists, but it is filled by the
 * enrichment job from the provider's own record and is usable as an authorization input only
 * because of where it came from.
 *
 * ENRICHMENT IS NOT ON THIS PATH. The provider's user endpoint needs a second credential and is
 * heavily rate-limited, so a login completes with the DID alone and `enriched_at` stays NULL. That
 * NULL is the cursor the enrichment job selects on; nothing else is needed to "queue" the work, and
 * a request never waits on the provider.
 *
 * BOOTSTRAP ADMINS ARE RE-EVALUATED ON EVERY LOGIN, not only at provisioning: adding a DID to
 * `BOOTSTRAP_ADMIN_PRIVY_DIDS` has to take effect without anybody touching the database, which is
 * the entire point of having the variable. The promotion is audited like any other role change.
 */
import { and, eq, ilike, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, accounts, orgMemberships, organizations } from "../../../db/schema.js";
import type { Membership } from "../../shared/capabilities.js";
import { badRequest, conflict } from "../../shared/http-error.js";
import { AuditService, SYSTEM_ACTOR } from "../audit/audit.service.js";

/** A handle is public and appears in `source.submittedBy`, so it is held to slug shape. */
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE_MIN = 3;
const HANDLE_MAX = 40;
const DISPLAY_NAME_MAX = 120;

/** A membership as a human reads it, rather than as the authorization path needs it. */
export interface DetailedMembership extends Membership {
  name: string;
  role: "owner" | "admin" | "publisher";
}

export interface ProfileUpdate {
  handle?: string | null;
  displayName?: string | null;
}

export class AccountService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: DB = defaultDb,
    private readonly bootstrapAdminDids: string[] = [],
  ) {
    this.audit = new AuditService(db);
  }

  /**
   * The account for a verified DID, creating it if this is the first login.
   *
   * `ON CONFLICT DO NOTHING` followed by a read rather than a read-then-insert: two tabs logging in
   * at once is an ordinary race, and the unique index is the only arbiter that cannot lose it.
   */
  async resolveByPrivyDid(did: string): Promise<AccountRow> {
    await this.db.insert(accounts).values({ privyDid: did }).onConflictDoNothing();
    const rows = await this.db.select().from(accounts).where(eq(accounts.privyDid, did)).limit(1);
    const account = rows[0];
    if (!account) throw new Error(`account for '${did}' vanished between insert and read`);
    return this.applyBootstrapAdmin(account);
  }

  /** Promote a configured bootstrap DID to admin. Idempotent, and audited the first time only. */
  private async applyBootstrapAdmin(account: AccountRow): Promise<AccountRow> {
    if (account.globalRole === "admin") return account;
    if (account.privyDid === null || !this.bootstrapAdminDids.includes(account.privyDid)) {
      return account;
    }
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(accounts)
        .set({ globalRole: "admin", updatedAt: new Date() })
        .where(and(eq(accounts.id, account.id), eq(accounts.globalRole, account.globalRole)))
        .returning();
      const row = updated[0];
      if (!row) return account;
      await this.audit.record(tx, {
        ...SYSTEM_ACTOR,
        subjectKind: "account",
        subjectId: row.id,
        action: "assign_role",
        patch: {
          globalRole: { before: account.globalRole, after: "admin" },
          reason: "bootstrap_admin_privy_did",
        },
      });
      return row;
    });
  }

  async findById(id: number): Promise<AccountRow | undefined> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return rows[0];
  }

  /**
   * The organizations this account publishes for, with each one's verified state.
   *
   * Both halves are needed together: the membership says which namespace, the verified flag says
   * whether a write into it auto-approves. Reading them separately is how the two answers drift.
   */
  async memberships(accountId: number): Promise<Membership[]> {
    const rows = await this.db
      .select({ slug: organizations.slug, verified: organizations.verified })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(orgMemberships.accountId, accountId));
    return rows;
  }

  /**
   * The same memberships, with the organization's name and the account's role in it — what `/v1/me`
   * shows a human. The authorization path deliberately does NOT use this: it needs the slug and the
   * verified flag and nothing else, and a wider read on a hot path is a wider read.
   */
  async membershipsDetailed(accountId: number): Promise<DetailedMembership[]> {
    return this.db
      .select({
        slug: organizations.slug,
        name: organizations.name,
        verified: organizations.verified,
        role: orgMemberships.role,
      })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId))
      .where(eq(orgMemberships.accountId, accountId))
      .orderBy(organizations.slug);
  }

  /** `PATCH /v1/me`. Session-only at the route; the shape rules live here. */
  async updateProfile(accountId: number, update: ProfileUpdate): Promise<AccountRow> {
    const set: Partial<AccountRow> = { updatedAt: new Date() };

    if (update.handle !== undefined) {
      if (update.handle === null) {
        set.handle = null;
      } else {
        const handle = update.handle.trim().toLowerCase();
        if (
          handle.length < HANDLE_MIN ||
          handle.length > HANDLE_MAX ||
          !HANDLE.test(handle) ||
          handle === "community"
        ) {
          throw badRequest(
            "invalid_handle",
            `\`handle\` must be ${HANDLE_MIN}–${HANDLE_MAX} lowercase alphanumerics separated by single hyphens, and may not be "community" (which is what an unattributed submission is credited to). Got ${JSON.stringify(update.handle)}.`,
          );
        }
        set.handle = handle;
      }
    }

    if (update.displayName !== undefined) {
      const name = update.displayName === null ? null : update.displayName.trim();
      if (name !== null && name.length > DISPLAY_NAME_MAX) {
        throw badRequest(
          "invalid_display_name",
          `\`displayName\` must be at most ${DISPLAY_NAME_MAX} characters.`,
        );
      }
      set.displayName = name === "" ? null : name;
    }

    try {
      const rows = await this.db
        .update(accounts)
        .set(set)
        .where(eq(accounts.id, accountId))
        .returning();
      const row = rows[0];
      if (!row) throw new Error(`account ${accountId} vanished during a profile update`);
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("handle_taken", "that handle is already in use.");
      }
      throw error;
    }
  }

  /** T3 account discovery for the review screens. Matches handle, display name or DID exactly. */
  async search(q: string | undefined, limit = 25): Promise<AccountRow[]> {
    const query = (q ?? "").trim();
    if (query === "") {
      return this.db.select().from(accounts).orderBy(accounts.id).limit(limit);
    }
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const match = or(
      ilike(accounts.handle, like),
      ilike(accounts.displayName, like),
      eq(accounts.privyDid, query),
    );
    return this.db.select().from(accounts).where(match).orderBy(accounts.id).limit(limit);
  }
}

/** Postgres unique-violation SQLSTATE. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

/** The constraint a unique violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const named = error as { constraint?: string };
  return named.constraint;
}
