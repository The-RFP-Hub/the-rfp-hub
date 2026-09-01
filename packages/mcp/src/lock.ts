/**
 * Cross-process mutual exclusion on `mkdir`, which fails atomically on an existing path everywhere
 * this runs. STALE LOCKS ARE BROKEN, NOT WAITED ON FOREVER, and breaking is itself atomic: the
 * stale directory is RENAMED aside, so a second breaker cannot delete the first's fresh lock.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How long a lock may exist before it is presumed abandoned. */
export const STALE_LOCK_MS = 5_000;

/** How long a caller waits for a contended lock before giving up. */
export const LOCK_TIMEOUT_MS = 2_000;

/** Busy-wait granularity; the critical section is microseconds. */
const POLL_MS = 5;

export class LockTimeoutError extends Error {
  constructor(dir: string) {
    super(
      `could not acquire the lock at ${dir} within ${LOCK_TIMEOUT_MS}ms; another process is holding it`,
    );
    this.name = "LockTimeoutError";
  }
}

function sleepSync(ms: number): void {
  // The only way to sleep synchronously without a spin that pins a core and worsens contention.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The `rename` IS the decision: exactly one contender can claim an abandoned lock. */
function breakStaleLock(dir: string): void {
  const tombstone = `${dir}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(dir, tombstone);
  } catch {
    return; // Another process claimed it first, or the holder released it. Both are fine.
  }
  try {
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {
    // A tombstone nobody deleted is inert litter.
  }
}

function ageMs(dir: string): number | null {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return null; // Gone between the failed mkdir and this stat: it is free now.
  }
}

/**
 * SYNCHRONOUS THROUGHOUT: an async lock would let another `await` in this process interleave inside
 * the critical section, which is worse than no lock because it looks like it works.
 */
export function withLock<T>(
  dir: string,
  critical: () => T,
  options: { staleMs?: number; timeoutMs?: number; now?: () => number } = {},
): T {
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = ageMs(dir);
      if (age !== null && age > staleMs) {
        breakStaleLock(dir);
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(dir);
      sleepSync(POLL_MS);
    }
  }

  try {
    // For a human debugging a stuck lock. Best-effort.
    try {
      fs.writeFileSync(path.join(dir, "owner"), String(process.pid), { mode: 0o600 });
    } catch {}
    return critical();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The lock will be broken as stale rather than held forever.
    }
  }
}
