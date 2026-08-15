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
 */
import { eq } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../../db/client.js";
import { type AccountRow, accounts } from "../../../db/schema.js";
import type { AccountSummaryView } from "../../shared/api-views.js";
import type { AccountRole } from "../../shared/capabilities.js";
import { badRequest, notFound } from "../../shared/http-error.js";
import { AuditService } from "../audit/audit.service.js";

const ROLES: AccountRole[] = ["submitter", "reviewer", "admin"];

export class AdminService {
  private readonly audit: AuditService;

  constructor(private readonly db: DB = defaultDb) {
    this.audit = new AuditService(db);
  }

  async assignRole(adminId: number, accountId: number, role: string): Promise<AccountSummaryView> {
    const target = normalizeRole(role);
    return this.db.transaction(async (tx) => {
      const row = await lockAccount(tx, accountId);
      if (row.globalRole === target) return toAccountSummary(row);
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

/** The account projection the review and admin screens read. Never the DID, never the email. */
export function toAccountSummary(row: AccountRow): AccountSummaryView {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    globalRole: row.globalRole,
    directCreate: row.directCreate,
    createdAt: row.createdAt.toISOString(),
  };
}
