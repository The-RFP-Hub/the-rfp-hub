/**
 * The out-of-band write approval: a file store, and the CLI operations over it.
 *
 * WHAT THIS ACHIEVES, EXACTLY. Binding a commit to a hash of the input it previewed stops the
 * commit from executing a DIFFERENT input than the one that was shown. That is input-binding, and
 * it is necessary. It is not consent: if the confirmation token comes back in the tool's own
 * response, the same model that read it can spend it in the same turn, and nobody outside the loop
 * ever saw anything.
 *
 * So no secret is ever returned to the caller. The tool returns a public digest, and the write is
 * unlocked only by a file that appears when a person runs `rfphub-mcp approve <id>` in a terminal
 * and reads what it prints.
 *
 * WHAT THIS DOES NOT ACHIEVE — and no document in this package may claim otherwise. The approval
 * is outside the MCP channel, but it is NOT isolated from an agent that holds a shell and a
 * filesystem as the same operating-system user. Coding agents routinely hold both; such an agent
 * can run this CLI in a pseudo-terminal or write the file directly, and 0600/0700 permissions do
 * not stop it, because it is that user. The honest claim is: approving leaves the tool channel and
 * becomes a deliberate act at the operator's terminal. The trust assumption is written down in
 * ADR 0012, along with the boundaries that would actually be separate (a host-provided approval
 * UI, a distinct OS identity, a signing key the agent's process cannot reach).
 *
 * THE DIGEST BINDS THE DESTINATION, NOT ONLY THE DOCUMENT. `sha256(document)` alone would let an
 * approval granted against staging be spent against production, or with a different credential.
 * Five components go in, and the terminal prints all five before asking.
 */
import fs from "node:fs";
import path from "node:path";
import { digestOf, sha256Hex } from "./canonical.js";
import { ToolError } from "./errors.js";
import { ensureDir, isRegularFile, secureFile } from "./state.js";

export { ensureDir } from "./state.js";

/** How long a preview waits for a human, and how long the approval it produces stays spendable. */
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The five things an approval is bound to. Every one is non-secret. */
export interface ApprovalBinding {
  /** Canonical origin of the API the write would go to. */
  apiOrigin: string;
  /** First 8 hex chars of SHA-256 of the credential. Never the credential. */
  keyFingerprint: string;
  operation: "submit_opportunity";
  /** The MCP revision this server speaks. */
  protocolVersion: string;
  /** SHA-256 over the canonical form of the document. */
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

// ── paths ────────────────────────────────────────────────────────────────────────
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

/**
 * Write through a temporary file and a rename, and refuse a path that is not securable.
 *
 * The rename replaces whatever was at the target — including a symlink, which is replaced rather
 * than followed. Both names are checked: the temporary one because it is what receives the bytes,
 * the final one because it is what the next process will read.
 */
function writeFile0600(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  secureFile(tmp);
  fs.renameSync(tmp, file);
  secureFile(file);
}

function readRecord<T>(file: string): T | null {
  // A record that is not a plain file is not a record. Following a symlink here would read
  // whatever it points at and treat that as an approval.
  if (!isRegularFile(file)) return null;
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

// ── pending (written by the preview phase) ───────────────────────────────────────
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
 * Claim a PREVIEW, atomically, at the moment a person confirms it.
 *
 * Reading the preview, printing it, and waiting for a human is a long window — seconds at least,
 * and as long as somebody leaves the terminal open. Everything can change inside it: the preview
 * can be revoked, it can expire, or a second `approve` for the same id can be sitting at its own
 * prompt. Writing the approval on the strength of what was read BEFORE the question would let two
 * confirmations produce two approvals, which is two writes out of one human decision.
 *
 * So the preview is claimed exactly the way an approval is: one `rename()`, atomic, ENOENT for the
 * loser. Whoever wins may write the approval; everyone else is refused. Expiry is re-checked after
 * the claim rather than before the question, because the answer can change while it is being asked.
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

// ── approvals (written by a person at a terminal) ────────────────────────────────
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
 * Claim an approval, ATOMICALLY, before any network call.
 *
 * `rename()` on a POSIX filesystem is atomic and fails with ENOENT when the source is gone, so two
 * processes racing the same approval produce exactly one winner and one `null`. Doing this BEFORE
 * the request — rather than deleting the file after a successful response — is what makes the
 * approval single-use even when the response never arrives.
 *
 * NOTHING EVER RENAMES IT BACK. After an ambiguous outcome the correct state is "may have been
 * written", and restoring the approval would invite a second write of the same document.
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

/**
 * Whether a stored decision is outside its window — including because the clock moved backwards.
 *
 * A record stamped in the FUTURE means the machine's clock went back after it was written, and the
 * only safe reading is that its window has passed: the alternative is that winding a clock back
 * revives an approval that had already expired.
 */
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
 * Say WHICH of the five bindings diverged, by looking for a stored record that agrees about the
 * document.
 *
 * The id is a hash of all five, so when any one of them changes the id changes and the lookup
 * simply misses — which on its own tells a caller nothing more useful than "no". Matching on
 * `documentHash` recovers the common cases (the destination moved, the credential was rotated)
 * and names them. When no record shares the document hash, the document itself is what changed,
 * and that is said instead.
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
    const record = readRecord<T>(path.join(dir, name));
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

/**
 * The five bindings, in the order the terminal prints them: where it goes, with which credential,
 * what operation, over which protocol, and which document.
 */
export function describeBinding(binding: ApprovalBinding): string {
  return [
    `  destination : ${binding.apiOrigin}`,
    `  credential  : ${binding.keyFingerprint} (fingerprint, not the key)`,
    `  operation   : ${binding.operation}`,
    `  protocol    : ${binding.protocolVersion}`,
    `  document    : sha256 ${binding.documentHash}`,
  ].join("\n");
}
