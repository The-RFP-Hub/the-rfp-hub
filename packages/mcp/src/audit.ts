/**
 * A local, append-only record of what this server was asked to do.
 *
 * THREE RULES MAKE IT SAFE TO KEEP.
 *
 * 1. `inputSummary` is the list of top-level argument KEYS and the byte length of the arguments —
 *    never the values. An audit log that stores values is a second copy of every document, every
 *    search term and, one day, of a credential somebody pasted into the wrong field.
 * 2. A FAILURE TO AUDIT NEVER FAILS THE TOOL. If the disk is full or the path is unwritable, the
 *    call still runs. Auditing is a record of what happened, not a precondition for it — the
 *    alternative is an unwritable log that takes the whole server down. It does NOT follow that
 *    anything goes: a path this process cannot establish as its own 0600 regular file is skipped
 *    rather than written to.
 * 3. IT IS BOUNDED. One line per call, forever, fills a disk. The file rotates at 5 MiB keeping a
 *    single `.1`, under the same kind of cross-process lock the counters use, and a rotation that
 *    fails costs a rotation, never a tool call.
 */
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";
import type { ToolKind } from "./policy.js";
import { redactString } from "./redact.js";
import { FILE_MODE, ensureDir, secureFile } from "./state.js";

/** Rotate at five mebibytes, keeping one previous generation. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export interface AuditEntry {
  at: string;
  tool: string;
  kind: ToolKind;
  /** `ok` or the error code the call ended with. */
  status: string;
  inputSummary: { keys: string[]; bytes: number };
  durationMs: number;
}

export function auditPath(home: string): string {
  return path.join(home, "audit.log");
}

/** The previous generation. There is exactly one; an older one is replaced. */
export function rotatedAuditPath(home: string): string {
  return `${auditPath(home)}.1`;
}

function auditLockPath(home: string): string {
  return path.join(home, "audit.lock");
}

/** Keys and byte length. Never values — see the file header. */
export function summarizeInput(args: unknown): { keys: string[]; bytes: number } {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(args ?? null), "utf8");
  } catch {
    bytes = -1; // Unserializable input: record that it was, not what it was.
  }
  const keys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>).sort()
      : [];
  return { keys, bytes };
}

/**
 * Move the log aside once it is over the cap.
 *
 * Under the lock, and re-measured inside it: two processes that both saw an oversized file must
 * not both rename, because the second would throw away the lines the first has already started
 * writing into the fresh one.
 */
export function rotateAudit(home: string): void {
  const file = auditPath(home);
  if (sizeOf(file) < AUDIT_MAX_BYTES) return;
  withLock(auditLockPath(home), () => {
    if (sizeOf(file) < AUDIT_MAX_BYTES) return;
    const previous = rotatedAuditPath(home);
    fs.renameSync(file, previous);
    secureFile(previous);
  });
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Append one line. Never throws. */
export function appendAudit(home: string, entry: AuditEntry): void {
  try {
    ensureDir(home);
    try {
      rotateAudit(home);
    } catch {
      // A log that could not be rotated is still a log worth appending to. Losing the line as
      // well would make a full disk erase the record of what happened on the way there.
    }
    const file = auditPath(home);
    try {
      // Exclusive create, so the file this process appends to is one it made at 0600. An existing
      // path — including a symlink — fails here and is judged by `secureFile` below instead.
      fs.closeSync(fs.openSync(file, "ax", FILE_MODE));
    } catch {
      // Already there, or not creatable. Either way the check below decides.
    }
    secureFile(file);
    fs.appendFileSync(file, `${redactString(JSON.stringify(entry))}\n`);
  } catch {
    // Deliberately swallowed. See rule 2 in the file header. Reporting it on stderr would be
    // noise on every call for a machine whose home directory is read-only.
  }
}
