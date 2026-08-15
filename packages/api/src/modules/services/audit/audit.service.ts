/**
 * The append-only history, and the two rules that make it worth keeping.
 *
 * 1. **A row is written with the same handle that wrote the mutation.** `record()` takes the
 *    transaction rather than reaching for the pool, so a rolled-back mutation cannot leave behind a
 *    history row claiming it happened, and a committed one cannot lack its row.
 * 2. **A correction is a new row.** There is no update path here and there cannot be: a database
 *    trigger (migration 0004) raises on `UPDATE` and `DELETE` against `audit_log`. Recording that
 *    an earlier action was wrong means recording a further action.
 *
 * The read side has two audiences with different rights, and both are served from the SAME
 * computation so the public view can never be a staler answer than the private one:
 *
 *   public          → `{action, at, actorKind, actor, changedFields}` — field NAMES only, because a
 *                     pending entry's contents are not public and neither is a publisher's contact;
 *   owner and T3+   → the same, plus the full `patch`.
 *
 * The actor is coarsened for the public view for the same reason: a trail that names which reviewer
 * rejected which entry is an invitation to go and argue with them personally.
 */
import { and, desc, eq } from "drizzle-orm";
import { type DbLike, db as defaultDb } from "../../../db/client.js";
import { accounts, auditLog } from "../../../db/schema.js";
import type { auditAction, auditSubjectKind } from "../../../db/schema.js";
import { type Patch, changedFields } from "../../shared/patch.js";

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

/** The system acting on nobody's behalf — a job, or a boot-time rule such as the admin bootstrap. */
export const SYSTEM_ACTOR: AuditActor = { actorKind: "job", actorAccountId: null };

/** What a reader is entitled to see. Computed by the caller from ownership and role. */
export interface AuditViewer {
  /** Owner of the subject, or T3+. Anyone else sees field names and a coarse actor. */
  full: boolean;
}

export interface AuditEntryRecord {
  action: AuditAction;
  at: string;
  actorKind: ActorKind;
  /** A public handle, an organization slug, `"reviewer"`, `"job"` or `"community"`. */
  actor: string;
  changedFields: string[];
  /** Present only for the owner and T3+. */
  patch?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly db: DbLike = defaultDb) {}

  /** Append one row. Takes the writing handle so history commits with the mutation or not at all. */
  async record(tx: DbLike, entry: AuditRecordInput): Promise<void> {
    await tx.insert(auditLog).values({
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      actorKind: entry.actorKind,
      actorAccountId: entry.actorAccountId ?? null,
      actorApiKeyId: entry.actorApiKeyId ?? null,
      action: entry.action,
      patch: (entry.patch ?? null) as Record<string, unknown> | null,
    });
  }

  /** The trail for one subject, newest first, projected for this viewer. */
  async list(
    subjectKind: AuditSubjectKind,
    subjectId: number,
    viewer: AuditViewer,
    limit = 100,
  ): Promise<AuditEntryRecord[]> {
    const rows = await this.db
      .select({
        action: auditLog.action,
        createdAt: auditLog.createdAt,
        actorKind: auditLog.actorKind,
        patch: auditLog.patch,
        actorHandle: accounts.handle,
        actorRole: accounts.globalRole,
      })
      .from(auditLog)
      .leftJoin(accounts, eq(accounts.id, auditLog.actorAccountId))
      .where(and(eq(auditLog.subjectKind, subjectKind), eq(auditLog.subjectId, subjectId)))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit);

    return rows.map((row) => {
      const patch = (row.patch ?? {}) as Patch;
      const view: AuditEntryRecord = {
        action: row.action,
        at: row.createdAt.toISOString(),
        actorKind: row.actorKind,
        actor: publicActor(row.actorKind, row.actorHandle, row.actorRole),
        changedFields: changedFields(patch),
      };
      if (viewer.full) view.patch = patch;
      return view;
    });
  }
}

/**
 * The coarse actor label.
 *
 * A reviewer or admin is `"reviewer"` whatever their handle: their action was taken in an editorial
 * capacity, and the trail's job is to say that an editor acted, not which one. A submitter is their
 * own public handle, because attribution is the point of a public handle.
 */
export function publicActor(
  actorKind: ActorKind,
  handle: string | null,
  role: "submitter" | "reviewer" | "admin" | null,
): string {
  if (actorKind === "job") return "job";
  if (actorKind === "outbox") return "outbox";
  if (role === "reviewer" || role === "admin") return "reviewer";
  return handle ?? "community";
}
