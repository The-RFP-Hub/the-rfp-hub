/**
 * The out-of-band write approval: a file store, and the CLI operations over it.
 *
 * Input-binding is not consent — a confirmation token returned in the tool's own response is
 * spendable by the same model in the same turn — so no secret is ever returned, and the write is
 * unlocked only by a file a person creates at a terminal. The digest binds FIVE components, not
 * the document alone. What this does NOT achieve is in ADR 0012 and the README, and no document
 * here may claim otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import { digestOf, sha256Hex } from "./canonical.js";
import { ToolError } from "./errors.js";
import { ensureDir, existsSecurely, secureFile } from "./state.js";

export { ensureDir } from "./state.js";

/** How long a preview waits for a human, and how long the approval it produces stays spendable. */
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The five things an approval is bound to. Every one is non-secret. */
export interface ApprovalBinding {
  apiOrigin: string;
  /** SHA-256 prefix of the credential. Never the credential. */
  keyFingerprint: string;
  operation: "submit_opportunity";
  protocolVersion: string;
  documentHash: string;
}

export interface PendingRecord extends ApprovalBinding {
  approvalId: string;
  /** The document, kept ONLY so the terminal can print it to the person approving. */
  document: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalRecord extends ApprovalBinding {
  approvalId: string;
  approvedAt: string;
  expiresAt: string;
}

/** The public, non-secret identifier: SHA-256 over the canonical form of the five bindings. */
export function computeApprovalId(binding: ApprovalBinding): string {
  return digestOf({
    apiOrigin: binding.apiOrigin,
    keyFingerprint: binding.keyFingerprint,
    operation: binding.operation,
    protocolVersion: binding.protocolVersion,
    documentHash: binding.documentHash,
  });
}

export function documentHashOf(document: unknown): string {
  return digestOf(document);
}

export function fingerprintOf(key: string | null): string {
  return key === null ? "none" : sha256Hex(key).slice(0, 8);
}

export function pendingDir(home: string): string {
  return path.join(home, "pending");
}
export function approvalsDir(home: string): string {
  return path.join(home, "approvals");
}
/** Where a spent approval goes. The rename into here IS the single-use claim. */
export function claimedDir(home: string): string {
  return path.join(approvalsDir(home), "claimed");
}

const ID_SHAPE = /^[0-9a-f]{64}$/;

export function assertApprovalId(id: string): void {
  if (!ID_SHAPE.test(id)) {
    throw new ToolError(
      "invalid_input",
      "An approval id is 64 lowercase hexadecimal characters, as printed by the preview.",
    );
  }
}

/** The rename REPLACES a symlink at the target rather than following it. Both names are checked. */
function writeFile0600(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  secureFile(tmp);
  fs.renameSync(tmp, file);
  secureFile(file);
}

/**
 * A record, or `null` when there is none. THROWS when there is one that cannot be trusted: reading
 * a decision file something else could have written lets whatever wrote it authorize a submission.
 */
function readRecord<T>(file: string): T | null {
  if (!existsSecurely(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writePending(home: string, record: PendingRecord): void {
  writeFile0600(
    path.join(pendingDir(home), `${record.approvalId}.json`),
    JSON.stringify(record, null, 2),
  );
}

export function readPending(home: string, approvalId: string): PendingRecord | null {
  return readRecord<PendingRecord>(path.join(pendingDir(home), `${approvalId}.json`));
}

export function listPending(home: string): PendingRecord[] {
  return listDir<PendingRecord>(pendingDir(home));
}

export function deletePending(home: string, approvalId: string): boolean {
  return unlinkIfExists(path.join(pendingDir(home), `${approvalId}.json`));
}

/** Where a preview goes once a person has turned it into an approval. */
export function claimedPendingDir(home: string): string {
  return path.join(pendingDir(home), "claimed");
}

/**
 * Claimed by one atomic `rename()` AT THE MOMENT a person confirms, not when the preview was
 * printed: the wait for a human is unbounded, and two confirmations must not mint two approvals.
 */
export function claimPending(home: string, approvalId: string): PendingRecord | null {
  const from = path.join(pendingDir(home), `${approvalId}.json`);
  const record = readRecord<PendingRecord>(from);
  if (record === null) return null;
  ensureDir(claimedPendingDir(home));
  try {
    fs.renameSync(from, path.join(claimedPendingDir(home), `${approvalId}.json`));
  } catch {
    return null; // Revoked, or another `approve` won the race between the read and the rename.
  }
  return record;
}

export function writeApproval(home: string, record: ApprovalRecord): void {
  writeFile0600(
    path.join(approvalsDir(home), `${record.approvalId}.json`),
    JSON.stringify(record, null, 2),
  );
}

export function readApproval(home: string, approvalId: string): ApprovalRecord | null {
  return readRecord<ApprovalRecord>(path.join(approvalsDir(home), `${approvalId}.json`));
}

export function listApprovals(home: string): ApprovalRecord[] {
  return listDir<ApprovalRecord>(approvalsDir(home));
}

export function deleteApproval(home: string, approvalId: string): boolean {
  return unlinkIfExists(path.join(approvalsDir(home), `${approvalId}.json`));
}

/**
 * One atomic `rename()` BEFORE the request, which is what makes the approval single-use even when
 * the response never arrives. NOTHING EVER RENAMES IT BACK.
 */
export function claimApproval(home: string, approvalId: string): ApprovalRecord | null {
  const from = path.join(approvalsDir(home), `${approvalId}.json`);
  const record = readRecord<ApprovalRecord>(from);
  if (record === null) return null;
  const to = path.join(claimedDir(home), `${approvalId}.json`);
  ensureDir(claimedDir(home));
  try {
    fs.renameSync(from, to);
  } catch {
    return null; // Another process won the race, or the file vanished between read and rename.
  }
  return record;
}

/** A record stamped in the FUTURE means the clock went back; treating it as live would revive
 * an approval that had already expired. */
export function isExpired(
  record: { expiresAt: string; createdAt?: string; approvedAt?: string },
  now: Date,
): boolean {
  const at = Date.parse(record.expiresAt);
  if (!Number.isFinite(at)) return true;
  const issued = Date.parse(record.approvedAt ?? record.createdAt ?? "");
  if (Number.isFinite(issued) && issued > now.getTime()) return true;
  return at <= now.getTime();
}

/**
 * The id hashes all five, so any change makes the lookup simply miss — which tells a caller
 * nothing. Matching on `documentHash` recovers and names the common divergences.
 */
export function diagnoseMismatch(
  home: string,
  binding: ApprovalBinding,
): { component: string; expected: string; actual: string } | null {
  const candidates: ApprovalBinding[] = [...listApprovals(home), ...listPending(home)];
  for (const candidate of candidates) {
    if (candidate.documentHash !== binding.documentHash) continue;
    if (candidate.apiOrigin !== binding.apiOrigin) {
      return { component: "apiOrigin", expected: candidate.apiOrigin, actual: binding.apiOrigin };
    }
    if (candidate.keyFingerprint !== binding.keyFingerprint) {
      return {
        component: "keyFingerprint",
        expected: candidate.keyFingerprint,
        actual: binding.keyFingerprint,
      };
    }
    if (candidate.protocolVersion !== binding.protocolVersion) {
      return {
        component: "protocolVersion",
        expected: candidate.protocolVersion,
        actual: binding.protocolVersion,
      };
    }
    if (candidate.operation !== binding.operation) {
      return { component: "operation", expected: candidate.operation, actual: binding.operation };
    }
  }
  return null;
}

function listDir<T extends { approvalId: string }>(dir: string): T[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: T | null;
    try {
      record = readRecord<T>(path.join(dir, name));
    } catch {
      continue; // An untrustworthy record is not listed, which is the fail-closed direction.
    }
    if (record !== null && typeof record.approvalId === "string") out.push(record);
  }
  return out;
}

function unlinkIfExists(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The five bindings, in the order the terminal prints them. */
export function describeBinding(binding: ApprovalBinding): string {
  return [
    `  destination : ${binding.apiOrigin}`,
    `  credential  : ${binding.keyFingerprint} (fingerprint, not the key)`,
    `  operation   : ${binding.operation}`,
    `  protocol    : ${binding.protocolVersion}`,
    `  document    : sha256 ${binding.documentHash}`,
  ].join("\n");
}
