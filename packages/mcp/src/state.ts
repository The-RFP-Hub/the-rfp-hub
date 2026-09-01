/**
 * The local state directory, and the properties it must actually have before anything trusts it.
 *
 * `RFPHUB_MCP_HOME` holds write approvals and rate-limit counters — security decisions kept in
 * files — so "0700 directory, 0600 files" is a precondition to be CHECKED, not requested: a mode
 * asked for at creation says nothing about a path that already existed, and a path that is a
 * symlink is not the path that was configured. Establish it, or refuse.
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

/** The read-back is the point: `chmod` can report success where modes are not carried at all. */
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
    // Diagnosed below: a symlink where the directory belongs surfaces here as EEXIST or ENOENT.
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
  // A second name for the same inode is a read path this directory's mode does not cover.
  if (stats.nlink > 1) throw new InsecureStateError(file, "has more than one hard link");
  enforceMode(file, FILE_MODE, stats);
}

/**
 * Whether `file` exists, refusing outright when it exists and cannot be trusted. VERIFICATION, NOT
 * REPAIR: a counter or approval file that was ALREADY world-readable or hard-linked has been
 * exposed, and tightening it afterwards makes neither its counts nor its decisions trustworthy.
 */
export function existsSecurely(file: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new InsecureStateError(file, "could not be inspected");
  }
  if (stats.isSymbolicLink()) throw new InsecureStateError(file, "is a symbolic link");
  if (!stats.isFile()) throw new InsecureStateError(file, "is not a regular file");
  if (stats.nlink > 1) throw new InsecureStateError(file, "has more than one hard link");
  if (MODES_ENFORCED && (stats.mode & 0o777) !== FILE_MODE) {
    throw new InsecureStateError(
      file,
      `is mode ${octal(stats.mode)} rather than ${octal(FILE_MODE)}, and a file this server is about to trust is verified rather than repaired`,
    );
  }
  return true;
}

/**
 * `secureFile`'s guarantees about the DESCRIPTOR rather than the path: the two are different files
 * whenever anything moves the path in between — this log's own rotation, from another process.
 */
export function secureOpenFile(fd: number, file: string): void {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) throw new InsecureStateError(file, "is not a regular file");
  if (stats.nlink > 1) throw new InsecureStateError(file, "has more than one hard link");
  if (!MODES_ENFORCED || (stats.mode & 0o777) === FILE_MODE) return;
  try {
    fs.fchmodSync(fd, FILE_MODE);
  } catch {
    throw new InsecureStateError(file, `is mode ${octal(stats.mode)} and could not be changed`);
  }
  const after = fs.fstatSync(fd);
  if ((after.mode & 0o777) !== FILE_MODE) {
    throw new InsecureStateError(file, `stayed at mode ${octal(after.mode)} after a chmod`);
  }
}
