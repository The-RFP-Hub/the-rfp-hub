/**
 * A local, append-only record of what this server was asked to do.
 *
 * `inputSummary` is argument KEYS and a byte length, never values — a log that stored values would
 * be a second copy of every document and every search term. A failure to audit never fails the
 * tool, but that does not mean anything goes: a path this process cannot establish as its own 0600
 * regular file is skipped rather than written to. And it is bounded: 5 MiB, one `.1` generation.
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

/** There is exactly one; an older one is replaced. */
export function rotatedAuditPath(home: string): string {
  return `${auditPath(home)}.1`;
}

function auditLockPath(home: string): string {
  return path.join(home, "audit.lock");
}

/** Keys and byte length. Never values. */
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

/** Re-measured under the lock: a second rename would discard the fresh file's first lines. */
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
      // A log that could not be rotated is still worth appending to.
    }
    const file = auditPath(home);
    try {
      // Exclusive create at 0600. An existing path — a symlink included — fails here and is
      // judged by `secureFile` below instead of being followed.
      fs.closeSync(fs.openSync(file, "ax", FILE_MODE));
    } catch {}
    secureFile(file);
    fs.appendFileSync(file, `${redactString(JSON.stringify(entry))}\n`);
  } catch {
    // Deliberately swallowed: stderr noise on every call for a read-only home helps nobody.
  }
}
