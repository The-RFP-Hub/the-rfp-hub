/**
 * A second connection whose OPEN TRANSACTION is the barrier a concurrency test schedules against.
 *
 * Racing the same request N times and hoping to observe the interleaving is not a test — it passes
 * on a fast machine and fails on a loaded one, and a security assertion that is retried into green
 * asserts nothing. So the schedule is made explicit instead: this connection takes a row lock (or
 * an uncommitted write) and holds it, the requests under test queue behind it in the database's own
 * wait queue, and the test decides when — and whether — they are released.
 *
 * `waitForWaiters` is what makes the arrangement deterministic AND self-checking. It polls
 * `pg_blocking_pids`, so it resolves only once the code under test has actually reached the lock
 * this barrier holds: a write path that never touches the locked row would never block, and the
 * wait would time out rather than pass by accident.
 *
 * TWO CONNECTIONS, NOT ONE. The holder cannot watch itself: a backend takes ONE snapshot of the
 * process-status array per transaction, so a `pg_stat_activity` poll issued inside the holder's own
 * open transaction keeps answering with the world as it was when the barrier was taken. The watcher
 * runs each poll as its own transaction and therefore sees the queue as it grows. Both are their
 * own `pg.Client`, deliberately outside the application pool — a barrier borrowed from the pool
 * would be a connection the requests under test might need.
 */
import pg from "pg";

const POLL_MS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface LockBarrier {
  /** The holder's backend pid — what `pg_blocking_pids` names when another one waits on it. */
  readonly pid: number;
  /** Run one statement inside the barrier's open transaction. */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Resolve once at least `count` backends are queued behind this one; throw if they never are. */
  waitForWaiters(count: number, timeoutMs?: number): Promise<void>;
  /** Commit and disconnect: the waiters proceed against the state this barrier wrote. */
  commit(): Promise<void>;
  /** Roll back and disconnect: the waiters proceed against the state as it was. Idempotent. */
  rollback(): Promise<void>;
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/** Open a barrier connection with a transaction already begun. */
export async function openLockBarrier(): Promise<LockBarrier> {
  const holder = await connect();
  const watcher = await connect();
  const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid;
  if (pid === undefined) throw new Error("the barrier connection has no backend pid");
  await holder.query("begin");

  let open = true;
  const settle = async (verb: "commit" | "rollback") => {
    if (!open) return;
    open = false;
    try {
      await holder.query(verb);
    } finally {
      await holder.end();
      await watcher.end();
    }
  };

  return {
    pid,
    async run(sql, params) {
      await holder.query(sql, params as unknown[] | undefined);
    },
    async waitForWaiters(count, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // The whole chain, not just the backends waiting on this one directly: the second waiter
        // for a row queues behind the FIRST waiter rather than behind the lock holder, so counting
        // only direct blockers would never see it.
        const { rows } = await watcher.query<{ waiting: number }>(
          `with recursive blocked as (
             select pid from pg_stat_activity where pid <> $1 and $1 = any(pg_blocking_pids(pid))
             union
             select waiter.pid
               from pg_stat_activity waiter
               join blocked on blocked.pid = any(pg_blocking_pids(waiter.pid))
           )
           select count(*)::int as waiting from blocked`,
          [pid],
        );
        const waiting = rows[0]?.waiting ?? 0;
        if (waiting >= count) return;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${count} backend(s) to block on the barrier (saw ${waiting}); the code under test never reached the locked row`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    commit: () => settle("commit"),
    rollback: () => settle("rollback"),
  };
}
