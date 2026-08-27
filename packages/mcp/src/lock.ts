/**
 * A cross-process mutual exclusion primitive, built on the one filesystem operation that gives it:
 * `mkdir` on a path that already exists fails, atomically, on every POSIX filesystem and on
 * Windows.
 *
 * WHY THIS EXISTS. Read-modify-write on a counter file is not a counter. Two processes that both
 * read `4`, both decide `4 < 5`, and both write `5` have spent one unit between them and let two
 * calls through a cap of five. That is not a theoretical race: an MCP client and a terminal running
 * the same package share one home directory by design, and an agent that opens several sessions
 * shares it several ways. A cap that a second process can walk through is not a cap.
 *
 * `O_EXCL` on a file would work equally well; a directory is used because removing it cannot
 * truncate anything a reader might be part-way through, and because the owner's pid can be left
 * inside it for a human debugging a stuck lock.
 *
 * STALE LOCKS ARE BROKEN, NOT WAITED ON FOREVER. A process killed between acquire and release
 * leaves the directory behind. Waiting on it forever would turn one crash into a permanently dead
 * install, so a lock older than `staleMs` is removed and re-contended for. The window is short
 * because the critical section is a file read and a rename — microseconds — so a lock that is
 * seconds old is not slow, it is abandoned.
 */
import fs from "node:fs";
import path from "node:path";

/** How long a lock may exist before it is presumed abandoned. */
export const STALE_LOCK_MS = 5_000;

/** How long a caller waits for a contended lock before giving up. */
export const LOCK_TIMEOUT_MS = 2_000;

/** Busy-wait granularity. Short, because the critical section is measured in microseconds. */
const POLL_MS = 5;

export class LockTimeoutError extends Error {
  constructor(dir: string) {
    super(
      `could not acquire the lock at ${dir} within ${LOCK_TIMEOUT_MS}ms; another process is holding it`,
    );
    this.name = "LockTimeoutError";
  }
}

/** Block this thread for `ms`. Synchronous on purpose — see `withLock`. */
function sleepSync(ms: number): void {
  // `Atomics.wait` on a throwaway buffer is the only way to sleep synchronously without a busy
  // loop that pins a core. A spin here would make contention worse, not better.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ageMs(dir: string): number | null {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return null; // Gone between the failed mkdir and this stat: it is free now.
  }
}

/**
 * Run `critical` while holding the lock at `<dir>`.
 *
 * SYNCHRONOUS THROUGHOUT. The counter update is synchronous file I/O, and making the lock async
 * would let another `await` in the same process interleave inside the critical section — a lock
 * that excludes other processes but not other tasks in this one is worse than none, because it
 * looks like it works.
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
        // The holder died. Remove and contend again; a second process doing the same thing at the
        // same moment is fine — exactly one of them will win the next `mkdir`.
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Somebody else removed it first, which is the outcome we wanted anyway.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(dir);
      sleepSync(POLL_MS);
    }
  }

  try {
    // For a human debugging a stuck lock. Best-effort: failing to write it must not fail the call.
    try {
      fs.writeFileSync(path.join(dir, "owner"), String(process.pid), { mode: 0o600 });
    } catch {
      // Non-fatal by design.
    }
    return critical();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The lock will be broken as stale rather than held forever.
    }
  }
}
