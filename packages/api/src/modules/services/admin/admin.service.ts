/**
 * The T4 surface: global roles, and the direct-create grant.
 *
 * `direct_create` is INDEPENDENT of `global_role`, and deliberately so: reviewing is not publishing.
 * An admin may want a trusted curator who can publish into any namespace without being able to
 * approve other people's submissions, and a reviewer who can approve without being able to publish
 * unreviewed. One column each, granted and revoked separately, audited both ways.
 *
 * Neither grant elevates an API key. `direct_create` widens which NAMESPACES an account may publish
 * into; whether the credential in hand may cause publication at all is still `canPublishWith`, so
 * a `write`-only key belonging to a direct-create admin still lands its submissions `pending`.
 *
 * ADMIN IS GRANTED AND REVOKED HERE like any other role — the product manages its own administrators
 * rather than deferring to a list in the environment. The one exception is the first one, which no
 * admin exists to make: that is an operator ceremony (`scripts/grant-admin.ts`, run with the
 * migration credential), and it is also how a lockout is undone.
 */
import { eq } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, accounts } from "../../../db/schema.js";
import type { AccountSummaryView } from "../../shared/api-views.js";
import type { AccountRole } from "../../shared/capabilities.js";
import { badRequest, conflict, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";

const ROLES: AccountRole[] = ["submitter", "reviewer", "admin"];

export class AdminService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  /**
   * Grant or revoke any global role, including `admin` — with one floor under it.
   *
   * THE LAST ADMIN CANNOT BE DEMOTED FROM HERE. Zeroing the admins is not a state the product can
   * undo: every route that could restore one requires an admin. It stays RECOVERABLE — an operator
   * runs `scripts/grant-admin.ts` against the database — but a dashboard should not be able to
   * reach it by accident, and "I demoted myself" is exactly the accident. Demoting an admin while
   * another remains is ordinary, self-demotion included.
   */
  async assignRole(adminId: number, accountId: number, role: string): Promise<AccountSummaryView> {
    const target = normalizeRole(role);
    return this.db.transaction(async (tx) => {
      // Every transaction that could REMOVE an admin locks the admin set first, in id order — the
      // same order in all of them, so two demotions racing serialise instead of deadlocking, and
      // neither can count the other's admin as still there. Taken before the target's own lock
      // because a demotion's target is itself in this set.
      const admins =
        target === "admin"
          ? []
          : await tx
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.globalRole, "admin"))
              .orderBy(accounts.id)
              .for("update");

      const row = await lockAccount(tx, accountId);
      if (row.globalRole === target) return toAccountSummary(row);
      // A privilege on an account nobody can sign in as is a ghost: it can never be exercised by
      // its owner, and it counts toward the last-admin guard, so a mistyped grant can convince the
      // product it has an administrator it does not have. Migration 0006 cleared the ones the
      // identity swap created; this is what stops the route from making new ones.
      //
      // DEMOTION IS STILL ALLOWED, deliberately: landing on `submitter` is the cleanup direction,
      // and refusing it would strand any such row as a permanent phantom admin that the guard keeps
      // counting.
      assertReachable(row, target !== "submitter");
      if (row.globalRole === "admin" && admins.length <= 1) {
        throw conflict(
          "last_admin",
          "this is the only admin account; promote another admin first. A lockout is recoverable only by an operator with the database credential.",
        );
      }
      const updated = await tx
        .update(accounts)
        .set({ globalRole: target, updatedAt: new Date() })
        .where(eq(accounts.id, accountId))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "account",
        subjectId: accountId,
        actorKind: "user",
        actorAccountId: adminId,
        action: "assign_role",
        patch: { globalRole: { before: row.globalRole, after: target } },
      });
      return toAccountSummary(next);
    });
  }

  async setDirectCreate(
    adminId: number,
    accountId: number,
    directCreate: boolean,
  ): Promise<AccountSummaryView> {
    return this.db.transaction(async (tx) => {
      const row = await lockAccount(tx, accountId);
      if (row.directCreate === directCreate) return toAccountSummary(row);
      // The same rule as the role: granting to an unreachable account creates a privilege nobody can
      // hold, revoking one is cleanup.
      assertReachable(row, directCreate);
      const updated = await tx
        .update(accounts)
        .set({ directCreate, updatedAt: new Date() })
        .where(eq(accounts.id, accountId))
        .returning();
      const next = updated[0] ?? row;
      await this.audit.record(tx, {
        subjectKind: "account",
        subjectId: accountId,
        actorKind: "user",
        actorAccountId: adminId,
        action: directCreate ? "grant_direct_create" : "revoke_direct_create",
        patch: { directCreate: { before: row.directCreate, after: directCreate } },
      });
      return toAccountSummary(next);
    });
  }
}

type TxLike = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Refuse to hand a privilege to an account that has no identity behind it.
 *
 * `accounts.auth_user_id` is NULL for a row that has lost — or never had — an identity, and there is
 * no foreign key to make that impossible (an accounts row must outlive its identity, because
 * `audit_log` points at it). So the check lives here, on the two routes that grant.
 */
function assertReachable(row: AccountRow, granting: boolean): void {
  if (!granting || row.authUserId !== null) return;
  throw conflict(
    "unreachable_account",
    "that account has no identity behind it — nobody can sign in as it — so granting it anything would create a privilege no person holds. It can still be demoted.",
  );
}

async function lockAccount(tx: TxLike, accountId: number): Promise<AccountRow> {
  const rows = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`no account ${accountId}.`);
  return row;
}

function normalizeRole(raw: string): AccountRole {
  const role = (raw ?? "").trim().toLowerCase();
  if (!(ROLES as string[]).includes(role)) {
    throw badRequest("invalid_role", `\`role\` must be one of ${ROLES.join(", ")}.`);
  }
  return role as AccountRole;
}

/** The account projection the review and admin screens read. The provider subject never leaves. */
export function toAccountSummary(row: AccountRow, email?: string | null): AccountSummaryView {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    ...(email !== undefined ? { email } : {}),
    globalRole: row.globalRole,
    directCreate: row.directCreate,
    createdAt: row.createdAt.toISOString(),
  };
}
