/**
 * The local state directory, and the properties it must actually have before anything trusts it.
 *
 * `RFPHUB_MCP_HOME` (default `~/.rfphub`) holds the write approvals and the rate-limit counters.
 * Both are security decisions kept in files, so "the directory is 0700 and the files are 0600" is
 * not documentation — it is a precondition, and it has to be CHECKED rather than requested. A mode
 * asked for at creation time says nothing about a path that already existed, and a path that is a
 * symlink is not the path that was configured.
 *
 * SO THE RULE IS: establish it, or refuse. Approvals and counters fail closed when the state
 * cannot be secured; the audit log stays non-fatal, but declines to append rather than writing
 * into something it could not secure.
 */
import fs from "node:fs";
import { ToolError } from "./errors.js";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Windows has no POSIX mode bits to verify; the type and identity checks still apply. */
const MODES_ENFORCED = process.platform !== "win32";

export class InsecureStateError extends ToolError {
  constructor(target: string, problem: string) {
    super(
      "policy_denied",
      `This server's local state at ${target} ${problem}, so the call is refused. Approvals and rate-limit counters only mean anything while they are this user's own files — a directory at 0700, files at 0600, no symlinks. Fix that path, or point RFPHUB_MCP_HOME at somewhere this user owns.`,
      { path: target },
    );
  }
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Bring an existing path to `mode`, then read it back.
 *
 * The read-back is the point. `chmod` can report success on filesystems that do not carry POSIX
 * modes at all, and a mode that was requested is not a mode that is in force.
 */
function enforceMode(target: string, mode: number, stats: fs.Stats): void {
  if (!MODES_ENFORCED || (stats.mode & 0o777) === mode) return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    throw new InsecureStateError(
      target,
      `is mode ${octal(stats.mode)} and could not be changed to ${octal(mode)}`,
    );
  }
  const after = fs.lstatSync(target);
  if ((after.mode & 0o777) !== mode) {
    throw new InsecureStateError(target, `stayed at mode ${octal(after.mode)} after a chmod`);
  }
}

/** `mkdir -p` at 0700, then prove that what is there really is a 0700 directory. */
export function ensureDir(dir: string): void {
  let failure: unknown;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    // Diagnosed below rather than rethrown: a symlink — dangling or not — where the directory
    // belongs surfaces here as EEXIST or ENOENT, and the useful message is about the symlink.
    failure = err;
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(dir);
  } catch {
    if (failure instanceof Error) throw failure;
    throw new InsecureStateError(dir, "could not be created");
  }
  if (stats.isSymbolicLink()) throw new InsecureStateError(dir, "is a symbolic link");
  if (!stats.isDirectory()) throw new InsecureStateError(dir, "is not a directory");
  enforceMode(dir, DIR_MODE, stats);
}

/** Prove that `file` is this user's own regular 0600 file, and make it so if it merely can be. */
export function secureFile(file: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    throw new InsecureStateError(file, "could not be inspected");
  }
  if (stats.isSymbolicLink()) throw new InsecureStateError(file, "is a symbolic link");
  if (!stats.isFile()) throw new InsecureStateError(file, "is not a regular file");
  // A second name for the same inode is a second way to read it that this directory's mode does
  // not cover.
  if (stats.nlink > 1) throw new InsecureStateError(file, "has more than one hard link");
  enforceMode(file, FILE_MODE, stats);
}

/** Whether `file` is a regular file this process may read as state. Never throws. */
export function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
