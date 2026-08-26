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
 * rejected which entry is an invitation to go and argue with them personally — and the capacity it
 * is coarsened by is RECORDED WITH THE ROW rather than looked up when it is read, because a role is
 * revocable and the trail must say what was true when the action was taken.
 */
import { type DB, type DbLike, db as defaultDb } from "../../../db/client.js";
import {
  type ActorKind,
  type AuditAction,
  type AuditActor,
  type AuditRecordInput,
  type AuditSubjectKind,
  type Repositories,
  repositories,
} from "../../repositories/index.js";
import { type Patch, changedFields } from "../../shared/patch.js";

export type { ActorKind, AuditAction, AuditActor, AuditRecordInput, AuditSubjectKind };

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
  private readonly repos: Repositories;

  constructor(private readonly db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  /** @deprecated transitional — call repos.audit.record(entry). Deleted in the final migration run. */
  async record(exec: DbLike | Repositories, entry: AuditRecordInput): Promise<void> {
    const repos = "audit" in exec ? exec : repositories(exec);
    await repos.audit.record(entry);
  }

  /** The trail for one subject, newest first, projected for this viewer. */
  async list(
    subjectKind: AuditSubjectKind,
    subjectId: number,
    viewer: AuditViewer,
    limit = 100,
  ): Promise<AuditEntryRecord[]> {
    const rows = await this.repos.audit.list(subjectKind, subjectId, limit);

    return rows.map((row) => {
      const patch = (row.patch ?? {}) as Patch;
      const view: AuditEntryRecord = {
        action: row.action,
        at: row.createdAt.toISOString(),
        actorKind: row.actorKind,
        actor: publicActor(
          row.actorKind,
          row.actorHandle,
          row.actorRole ?? row.currentRole,
          (patch as { via?: unknown }).via,
        ),
        changedFields: changedFields(patch),
      };
      if (viewer.full) view.patch = patch;
      return view;
    });
  }
}

/**
 * The `patch.via` value that says a decision was taken in a PUBLISHER capacity.
 *
 * Written by the organisation-scoped decision routes and read by `publicActor`. It is a fact about
 * WHICH HAT the actor wore, which is a different question from what roles they hold — and the only
 * one the public label is trying to answer.
 */
export const OPERATING_ORG_CAPACITY = "operating_org";

/**
 * The coarse actor label.
 *
 * A reviewer or admin is `"reviewer"` whatever their handle: their action was taken in an editorial
 * capacity, and the trail's job is to say that an editor acted, not which one. A submitter is their
 * own public handle, because attribution is the point of a public handle.
 *
 * The role passed here is the one STORED with the row (`audit_log.actor_role`), not the one the
 * account holds today — see the column's comment. Demoting a reviewer must not retroactively put
 * their handle on everything they ever rejected.
 *
 * CAPACITY OVERRIDES ROLE, and only in this direction. A decision taken through an organisation's
 * own routes is made as that organisation's publisher, and it is NAMED: anyone may submit an entry
 * about an organisation, so the organisation deciding about it is the case that most needs somebody
 * answerable attached to it. Without this, a member who also happens to be Hub staff would be
 * anonymised as "reviewer" by a global role that had nothing to do with the decision — the
 * anonymity exists to protect a NEUTRAL reviewer from being argued with personally, and a
 * self-interested party is not that. The same person deciding through the STAFF route is coarsened
 * exactly as before, because there they really are acting as a reviewer.
 */
export function publicActor(
  actorKind: ActorKind,
  handle: string | null,
  role: "submitter" | "reviewer" | "admin" | null,
  capacity?: unknown,
): string {
  if (actorKind === "job") return "job";
  if (actorKind === "outbox") return "outbox";
  if (capacity === OPERATING_ORG_CAPACITY) return handle ?? "community";
  if (role === "reviewer" || role === "admin") return "reviewer";
  return handle ?? "community";
}
