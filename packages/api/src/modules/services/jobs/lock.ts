/**
 * The mutual exclusion that makes a scheduled job safe to start twice.
 *
 * Two runs of the same job can overlap for entirely ordinary reasons — a scheduled run starting
 * late while a manual one is still going, a retry of a task whose previous attempt has not yet
 * noticed it lost its network. What each job does is idempotent, but doing it twice CONCURRENTLY is
 * a different question from doing it twice in sequence, and the answer here is simply: don't.
 *
 * THREE DECISIONS, EACH OF WHICH CLOSES SOMETHING REAL.
 *
 * 1. **`pg_try_advisory_lock`, never `pg_advisory_lock`.** The blocking form cannot report
 *    contention — it waits, so a second run queues behind the first and starts the moment it ends,
 *    which is the opposite of skipping. The `try` form returns a boolean, and `false` is the answer
 *    the runner reports as `{skipped: "locked"}` and exits 0 on: a run that correctly declined to
 *    start is not a failed run.
 *
 * 2. **A DEDICATED client, never the pool.** A session-level advisory lock belongs to the
 *    CONNECTION that took it. Taking one through a pool means the unlock can be issued on a
 *    different connection — which silently does nothing, leaves the lock held for the lifetime of
 *    the borrowed connection, and blocks every later run until that connection happens to be
 *    recycled. One `pg.Client`, opened for the lock and closed with it.
 *
 * 3. **Unlock and disconnect in `finally`.** A throwing job must not leave the lock behind. The
 *    session-scoped lock would in fact be released when the client disconnects, but relying on that
 *    makes correctness depend on the socket closing promptly; the explicit unlock is what the next
 *    run's `try` sees immediately.
 *
 * The key is derived from the job's name so two different jobs never exclude each other, and the
 * same job excludes itself across processes, hosts and container tasks — the lock lives in the
 * database, which is the only thing every runner shares.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { config } from "../../../config.js";

/** What a run reports when another holder had the lock. Distinct from a feature being off. */
export const LOCKED = "locked";

/**
 * A stable 64-bit key for a job name.
 *
 * A signed BIGINT is what `pg_try_advisory_lock(bigint)` takes, so the top bit of the digest is
 * masked off rather than allowed to produce a value outside the range — a collision between two
 * job names would merely serialise them, while an out-of-range literal is an error at run time.
 */
export function advisoryLockKey(name: string): bigint {
  const digest = createHash("sha256").update(`rfphub:job:${name}`).digest();
  return digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

export interface LockedRun<T> {
  /** True when the lock was taken and `run` was executed. */
  ran: boolean;
  result?: T;
}

/**
 * Run `work` while holding the advisory lock for `name`, or report that somebody else holds it.
 *
 * The connection string is read at call time rather than captured at import, so a test can point
 * `DATABASE_URL` at a throwaway instance and get a lock in the same database its pool is using —
 * an advisory lock in a different database is not a lock at all.
 */
export async function withJobLock<T>(
  name: string,
  work: () => Promise<T>,
  options: { connectionString?: string } = {},
): Promise<LockedRun<T>> {
  const client = new pg.Client({
    connectionString: options.connectionString ?? config.databaseUrl,
  });
  await client.connect();
  let held = false;
  try {
    const key = advisoryLockKey(name);
    // The key is passed as a parameter, not interpolated: it is a bigint, and node-postgres
    // serialises it as a string the server casts back.
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [key.toString()],
    );
    held = locked.rows[0]?.locked === true;
    if (!held) return { ran: false };
    return { ran: true, result: await work() };
  } finally {
    if (held) {
      // A failure to unlock must not mask the job's own error, and it is not itself fatal: the
      // lock is session-scoped, so `client.end()` below releases it either way.
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [advisoryLockKey(name).toString()])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}
