/**
 * A local, append-only record of what this server was asked to do.
 *
 * TWO RULES MAKE IT SAFE TO KEEP.
 *
 * 1. `inputSummary` is the list of top-level argument KEYS and the byte length of the arguments —
 *    never the values. An audit log that stores values is a second copy of every document, every
 *    search term and, one day, of a credential somebody pasted into the wrong field.
 * 2. A FAILURE TO AUDIT NEVER FAILS THE TOOL. If the disk is full or the path is unwritable, the
 *    call still runs. Auditing is a record of what happened, not a precondition for it — the
 *    alternative is an unwritable log that takes the whole server down.
 *
 * The file is 0600 in a 0700 directory. That is a courtesy against other users on the machine; it
 * is not protection against the user's own processes.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./approvals.js";
import type { ToolKind } from "./policy.js";
import { redactString } from "./redact.js";

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

/** Append one line. Never throws. */
export function appendAudit(home: string, entry: AuditEntry): void {
  try {
    ensureDir(home);
    const line = `${redactString(JSON.stringify(entry))}\n`;
    fs.appendFileSync(auditPath(home), line, { mode: 0o600 });
  } catch {
    // Deliberately swallowed. See rule 2 in the file header. Reporting it on stderr would be
    // noise on every call for a machine whose home directory is read-only.
  }
}
