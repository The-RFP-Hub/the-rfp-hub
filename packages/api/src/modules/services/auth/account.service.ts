/**
 * Accounts: provisioned on first login, keyed on the session's SUBJECT, and nothing else.
 *
 * WHAT THE SUBJECT IS. The opaque user id the identity tables mint — never an email address. An
 * address is a routable, transferable, re-assignable thing a person can change; the subject is the
 * one value that is stable for the life of the identity, which is why it and not the address is
 * what `audit_log` ends up pointing at through `accounts.id`. `grant-admin --email` looks an
 * address UP to find a subject; it never stores one.
 *
 * NO PROFILE IS COPIED HERE. The address, the display name the provider knows and the verification
 * state all live in the identity tables, and `/v1/me` joins for the address rather than keeping a
 * second copy that would drift. This table holds what the APPLICATION decides about an account:
 * its role, its direct-create grant, its public handle.
 *
 * LOGIN GRANTS NOTHING. A session resolves to whatever role the database already holds — there is
 * no list of privileged identities in the environment for a login to consult, because a role that
 * is re-derived from configuration on every request is a role nobody can revoke in the product.
 * The FIRST admin is made by an operator running `scripts/grant-admin.ts` with the migration
 * credential (`grantAdmin` below); every admin after that is made by an admin, over
 * `POST /v1/admin/accounts/:id/role`. Both write the same audited `assign_role` row.
 */
import { eq, getTableColumns, ilike, or } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import {
  type AccountRow,
  accounts,
  authUser,
  orgMemberships,
  organizations,
} from "../../../db/schema.js";
import type { Membership } from "../../shared/capabilities.js";
import { badRequest, conflict, notFound } from "../../shared/http-error.js";
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

/** The privileged directory projection. Email stays out of the public account row and `/v1/me`. */
export interface AccountSearchRow extends AccountRow {
  email: string | null;
}

/** What the admin ceremony did, so an operator's console can say which of the three happened. */
export interface AdminGrant {
  account: AccountRow;
  /** The account did not exist and `create` provisioned it. */
  created: boolean;
  /** False when the account was already an admin — a no-op, and no second audit row. */
  promoted: boolean;
}

export class AccountService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  /**
   * The account for a verified DID, creating it if this is the first login.
   *
   * `ON CONFLICT DO NOTHING` followed by a read rather than a read-then-insert: two tabs logging in
   * at once is an ordinary race, and the unique index is the only arbiter that cannot lose it.
   */
  async resolveBySubject(subject: string): Promise<AccountRow> {
    await this.db.insert(accounts).values({ authUserId: subject }).onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.authUserId, subject))
      .limit(1);
    const account = rows[0];
    if (!account) throw new Error(`account for '${subject}' vanished between insert and read`);
    return account;
  }

  /** The account a subject names, or `undefined`. The read half of the admin ceremony. */
  async findBySubject(subject: string): Promise<AccountRow | undefined> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.authUserId, subject))
      .limit(1);
    return rows[0];
  }

  /**
   * THE FIRST ADMIN — the one grant the product cannot make, because making it needs an admin.
   *
   * Reached only from `scripts/grant-admin.ts`, run by an operator against the database with the
   * migration credential. That is deliberately the same authority that can create the table: an
   * identity list in the service's environment would grant a role on every login, to whoever holds
   * the deployment configuration, with nothing in the product able to revoke it. Holding the
   * ceremony at the database instead means the grant is an EVENT, recorded once, and every later
   * admin is made by an admin over the audited route.
   *
   * `create` provisions the `accounts` row for an identity that has signed in but never made a
   * `/v1` request, with the same `ON CONFLICT DO NOTHING` idiom as `resolveBySubject` — an operator
   * should not have to choreograph "now go and call an endpoint, then be granted".
   *
   * Idempotent: an account that is already an admin is returned unchanged and writes no second
   * audit row. The lock is what makes the read-then-write safe against a concurrent role change.
   */
  async grantAdmin(subject: string, options: { create?: boolean } = {}): Promise<AdminGrant> {
    return this.db.transaction(async (tx) => {
      const locked = async () =>
        (
          await tx
            .select()
            .from(accounts)
            .where(eq(accounts.authUserId, subject))
            .for("update")
            .limit(1)
        )[0];

      let account = await locked();
      let created = false;
      if (!account) {
        if (options.create !== true) {
          throw notFound(`no account for ${JSON.stringify(subject)}.`);
        }
        await tx.insert(accounts).values({ authUserId: subject }).onConflictDoNothing();
        account = await locked();
        created = account !== undefined;
      }
      if (!account) throw new Error(`account for '${subject}' vanished between insert and read`);
      if (account.globalRole === "admin") return { account, created, promoted: false };

      const updated = await tx
        .update(accounts)
        .set({ globalRole: "admin", updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error(`account ${account.id} vanished during the admin grant`);
      await this.audit.record(tx, {
        // Nobody's account did this: an operator holding the migration credential did, and the
        // trail says so rather than naming an account that was not acting.
        ...SYSTEM_ACTOR,
        subjectKind: "account",
        subjectId: row.id,
        action: "assign_role",
        patch: {
          globalRole: { before: account.globalRole, after: "admin" },
          reason: "operator_grant_admin",
        },
      });
      return { account: row, created, promoted: true };
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

  /** T3 account discovery for staff screens. Email is joined only for this privileged read. */
  async search(q: string | undefined, limit = 25): Promise<AccountSearchRow[]> {
    const query = (q ?? "").trim();
    const select = () =>
      this.db
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
}

/**
 * The DRIVER's error, which is not necessarily the error that was thrown.
 *
 * Drizzle wraps a failed query in a `DrizzleQueryError` and hangs the driver's own error off
 * `cause`, so reading `code`/`constraint` from the thrown object answers `undefined` — and every
 * unique-violation rule downstream then reports a 500 where the contract promises a 409 or an
 * idempotent success. Walking the chain reads those fields wherever the wrapper happens to put
 * them, which is also what keeps this working if a future version stops wrapping. Bounded, because
 * a `cause` chain is not guaranteed to be acyclic.
 */
function driverError(error: unknown): { code?: string; constraint?: string } | undefined {
  let current = error;
  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) return undefined;
    const named = current as { code?: string; constraint?: string; cause?: unknown };
    if (named.code !== undefined || named.constraint !== undefined) return named;
    current = named.cause;
  }
  return undefined;
}

/** Postgres unique-violation SQLSTATE. */
export function isUniqueViolation(error: unknown): boolean {
  return driverError(error)?.code === "23505";
}

/** The constraint a unique violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}
