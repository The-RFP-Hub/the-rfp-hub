import { and, desc, eq } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { accounts, auditLog } from "../../../db/schema.js";
import type { auditAction, auditSubjectKind } from "../../../db/schema.js";
import type { Patch } from "../../shared/patch.js";

export type AuditAction = (typeof auditAction.enumValues)[number];
export type AuditSubjectKind = (typeof auditSubjectKind.enumValues)[number];
export type ActorKind = "user" | "api_key" | "job" | "outbox";

/** Who acted. `actorApiKeyId` is the question asked first when a key is suspected of leaking. */
export interface AuditActor {
  actorKind: ActorKind;
  actorAccountId?: number | null;
  actorApiKeyId?: number | null;
}

export interface AuditRecordInput extends AuditActor {
  subjectKind: AuditSubjectKind;
  subjectId: number;
  action: AuditAction;
  patch?: Patch | Record<string, unknown> | null;
}

export interface AuditListRow {
  action: AuditAction;
  createdAt: Date;
  actorKind: ActorKind;
  patch: unknown;
  actorHandle: string | null;
  actorRole: "submitter" | "reviewer" | "admin" | null;
  currentRole: "submitter" | "reviewer" | "admin" | null;
}

export class AuditRepository {
  constructor(private readonly exec: DbLike) {}

  /** Append one row. Takes the writing handle so history commits with the mutation or not at all. */
  async record(entry: AuditRecordInput): Promise<void> {
    await this.exec.insert(auditLog).values({
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      actorKind: entry.actorKind,
      actorAccountId: entry.actorAccountId ?? null,
      actorApiKeyId: entry.actorApiKeyId ?? null,
      actorRole: await this.actingRole(entry.actorAccountId),
      action: entry.action,
      patch: (entry.patch ?? null) as Record<string, unknown> | null,
    });
  }

  async list(
    subjectKind: AuditSubjectKind,
    subjectId: number,
    limit: number,
  ): Promise<AuditListRow[]> {
    return this.exec
      .select({
        action: auditLog.action,
        createdAt: auditLog.createdAt,
        actorKind: auditLog.actorKind,
        patch: auditLog.patch,
        actorHandle: accounts.handle,
        actorRole: auditLog.actorRole,
        // ONLY the fallback for rows written before `audit_log.actor_role` existed, which cannot be
        // backfilled (see the column's comment in `db/schema.ts`). For every row written since, the
        // stored capacity wins and this is not consulted — which is the whole point: a role change
        // must not reach backwards through the trail.
        currentRole: accounts.globalRole,
      })
      .from(auditLog)
      .leftJoin(accounts, eq(accounts.id, auditLog.actorAccountId))
      .where(and(eq(auditLog.subjectKind, subjectKind), eq(auditLog.subjectId, subjectId)))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit);
  }

  /**
   * The role the actor holds AS THIS MUTATION COMMITS, read with the writing handle.
   *
   * Read here rather than taken from the caller for two reasons. It needs no change at any of the
   * ~30 places that append a row — a signature that has to be threaded through a dozen services is a
   * signature somebody will forget, and a forgotten one silently degrades to the old leak. And it is
   * strictly MORE faithful than the caller's `principal.role`, which was resolved when the bearer was
   * exchanged and may already be stale: this read sits inside the same transaction as the mutation,
   * so it answers with the role that was true when the action landed.
   *
   * One primary-key lookup per audit row, on a row the writing transaction has usually already
   * touched.
   */
  private async actingRole(
    actorAccountId: number | null | undefined,
  ): Promise<"submitter" | "reviewer" | "admin" | null> {
    if (actorAccountId === null || actorAccountId === undefined) return null;
    const rows = await this.exec
      .select({ role: accounts.globalRole })
      .from(accounts)
      .where(eq(accounts.id, actorAccountId))
      .limit(1);
    return rows[0]?.role ?? null;
  }
}
