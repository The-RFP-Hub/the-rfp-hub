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
 *
 * `BOOTSTRAP_ADMIN_WALLETS` IS THE SAME RULE AGAINST A DIFFERENT COLUMN, and the difference is
 * where the value came from. `accounts.primary_wallet` is written by ONE thing — the enrichment
 * job, from the provider's own record — so matching against it is matching against something the
 * provider verified, not against a string a request asserted. It is therefore re-checked in the
 * two places the pair (account, wallet) can become true: on every login, like the DID list, and
 * immediately after enrichment writes the wallet, so the first admin does not have to log in twice.
 * Without `PRIVY_APP_SECRET` nothing ever writes that column, the list matches nothing, and
 * `config.ts` says so at boot.
 */
import { and, eq, ilike, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, accounts, orgMemberships, organizations } from "../../../db/schema.js";
import type { Membership } from "../../shared/capabilities.js";
import { badRequest, conflict } from "../../shared/http-error.js";
import { diffFields, isEmptyPatch } from "../../shared/patch.js";
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
    /** Lowercased by `config.ts`; compared against the provider-verified `primary_wallet`. */
    private readonly bootstrapAdminWallets: string[] = [],
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

  /**
   * Promote a configured bootstrap identity to admin. Idempotent, and audited the first time only.
   *
   * Two matchers, one rule. The DID is what the token itself carried; the wallet is what the
   * provider's own record said, stored by the enrichment job. Neither is a value a request supplied.
   * Public because enrichment calls it the moment it writes a wallet — an account already stamped
   * `enriched_at` is out of that job's cursor forever, so waiting for the next enrichment pass
   * would mean the promotion never happened.
   */
  async applyBootstrapAdmin(account: AccountRow): Promise<AccountRow> {
    if (account.globalRole === "admin") return account;
    const reason = this.bootstrapReason(account);
    if (reason === undefined) return account;
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(accounts)
        .set({ globalRole: "admin", updatedAt: new Date() })
        .where(and(eq(accounts.id, account.id), eq(accounts.globalRole, account.globalRole)))
        .returning();
      const row = updated[0];
      // Lost the compare-and-set: something else changed the role between the read and here, and
      // its decision is the newer one.
      if (!row) return account;
      await this.audit.record(tx, {
        ...SYSTEM_ACTOR,
        subjectKind: "account",
        subjectId: row.id,
        action: "assign_role",
        patch: {
          globalRole: { before: account.globalRole, after: "admin" },
          reason,
        },
      });
      return row;
    });
  }

  /** Which configured list this account matches, or `undefined` for neither. */
  private bootstrapReason(account: AccountRow): string | undefined {
    if (account.privyDid !== null && this.bootstrapAdminDids.includes(account.privyDid)) {
      return "bootstrap_admin_privy_did";
    }
    const wallet = account.primaryWallet?.trim().toLowerCase();
    if (wallet && this.bootstrapAdminWallets.includes(wallet)) {
      return "bootstrap_admin_wallet";
    }
    return undefined;
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

  /**
   * `PATCH /v1/me`. Session-only at the route; the shape rules live here.
   *
   * AUDITED, IN THE SAME TRANSACTION AS THE WRITE. The handle is not a cosmetic preference: it is
   * the public attribution `source.submittedBy` carries on everything this account has published,
   * so "who was this entry credited to last month" is only answerable if a rename is a recorded
   * event. `subject_kind='account'` is what the generalized audit table exists for — the old
   * opportunity-keyed table could not hold this row at all — and the actor is the account itself,
   * because the route admits no other credential.
   */
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
      return await this.db.transaction(async (tx) => {
        const before = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for("update")
          .limit(1);
        const previous = before[0];
        if (!previous) throw new Error(`account ${accountId} vanished during a profile update`);

        const rows = await tx
          .update(accounts)
          .set(set)
          .where(eq(accounts.id, accountId))
          .returning();
        const row = rows[0];
        if (!row) throw new Error(`account ${accountId} vanished during a profile update`);

        const patch = diffFields(
          { handle: previous.handle, displayName: previous.displayName },
          { handle: row.handle, displayName: row.displayName },
        );
        // A PATCH that changed nothing writes no history row, the same rule the write path uses.
        if (!isEmptyPatch(patch)) {
          await this.audit.record(tx, {
            subjectKind: "account",
            subjectId: row.id,
            actorKind: "user",
            actorAccountId: row.id,
            action: "update",
            patch,
          });
        }
        return row;
      });
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
