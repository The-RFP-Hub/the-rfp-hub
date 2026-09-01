/**
 * Rate caps per TOOL KIND, counted locally on disk.
 *
 * `read` is generous, `preview` is narrow, `commit` is very narrow. The point of the commit cap is
 * not throughput: it is that a compromised loop which somehow reaches the write path can do it a
 * handful of times a day, not a thousand.
 *
 * THE WHOLE CHECK-AND-INCREMENT IS UNDER A CROSS-PROCESS LOCK. Read-modify-write without one is
 * not a counter: two processes that both read `4`, both find `4 < 5`, and both write `5` have let
 * two calls through a cap of five. That is not hypothetical here — an MCP client and a terminal
 * running this same package share one home directory by design.
 *
 * FAIL-CLOSED. If the counter store cannot be read or written, or the lock cannot be taken, the
 * call is DENIED rather than allowed — a limiter that opens when its bookkeeping breaks is not a
 * limiter. The consequence is that `RFPHUB_MCP_HOME` (default `~/.rfphub`) has to be writable; the
 * README says so.
 *
 * THE KIND IS A PROPERTY OF THE INVOCATION, NOT OF THE TOOL. `submit_opportunity` is `preview` on
 * its first call and `commit` on its second, and only when the second call actually reaches the
 * POST. A fixed per-tool kind would either make previews spend the commit budget (so five previews
 * exhaust the day) or make the commit cap bypassable by repeating previews.
 */
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { LockTimeoutError, withLock } from "./lock.js";
import { ensureDir, isRegularFile, secureFile } from "./state.js";

/**
 * `attempt` is not a phase — it is every invocation of the write tool, charged before any work.
 *
 * The other three meter work that SUCCEEDED far enough to matter. That leaves the failures free:
 * a caller can send a thousand bogus approval ids, or a thousand oversized documents, and each one
 * is refused without spending anything, so the refusal path is an unmetered loop through local
 * validation and the filesystem. `attempt` closes it — the budget is spent whether or not the call
 * goes on to do anything.
 */
export type ToolKind = "read" | "preview" | "commit" | "attempt";

/** The only kinds a counter file may name. Anything else is corruption, not a newer build. */
export const TOOL_KINDS: readonly ToolKind[] = ["read", "preview", "commit", "attempt"];

export interface Caps {
  perMinute: number;
  perDay: number;
}

export const DEFAULT_CAPS: Readonly<Record<ToolKind, Caps>> = Object.freeze({
  read: { perMinute: 60, perDay: 5_000 },
  preview: { perMinute: 10, perDay: 200 },
  commit: { perMinute: 2, perDay: 5 },
  // Deliberately looser than `preview` and far tighter than `read`: a legitimate session takes a
  // few previews and a few refusals to get a document right, and nothing legitimate takes hundreds.
  attempt: { perMinute: 20, perDay: 400 },
});

interface Bucket {
  window: number;
  count: number;
}

interface CounterFile {
  minute: Partial<Record<ToolKind, Bucket>>;
  day: Partial<Record<ToolKind, Bucket>>;
}

const EMPTY: CounterFile = { minute: {}, day: {} };

export function counterPath(home: string): string {
  return path.join(home, "policy-counters.json");
}

/** The lock guarding every read-modify-write of the counter file. */
export function counterLockPath(home: string): string {
  return path.join(home, "policy-counters.lock");
}

export interface PolicyOptions {
  caps?: Readonly<Record<ToolKind, Caps>>;
  now?: () => Date;
  /** Test seam: shorten the wait so a contention test does not take seconds. */
  lockTimeoutMs?: number;
}

/**
 * A spent unit of budget, with the ability to give it back.
 *
 * This exists for one reason: the write path has to know it *can* spend commit budget before it
 * claims the human's approval, and the approval is the scarcer resource. So the budget is reserved
 * first; if anything between the reservation and the request fails — the approval was already
 * claimed by another process, say — the reservation is released and the caller has lost nothing.
 * Once the request is actually made the reservation is committed and stays spent, including when
 * the response never arrives.
 */
export interface Reservation {
  /** Keep the unit spent. Idempotent. */
  commit(): void;
  /** Give the unit back, because the work it was reserved for never happened. Idempotent. */
  release(): void;
}

export class Policy {
  private readonly home: string;
  private readonly caps: Readonly<Record<ToolKind, Caps>>;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number | undefined;

  constructor(home: string, options: PolicyOptions = {}) {
    this.home = home;
    this.caps = options.caps ?? DEFAULT_CAPS;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  /** Spend one unit of `kind`'s budget, or throw `rate_limited`. */
  consume(kind: ToolKind): void {
    this.reserve(kind).commit();
  }

  /**
   * Spend one unit of `kind`'s budget up front, returning a handle that can give it back.
   *
   * The unit is spent on disk immediately — a "reservation" that did not write would be exactly
   * the check-then-act race the lock exists to close.
   */
  reserve(kind: ToolKind): Reservation {
    const cap = this.caps[kind];
    const at = this.now().getTime();
    const minuteWindow = Math.floor(at / 60_000);
    const dayWindow = Math.floor(at / 86_400_000);

    this.locked(() => {
      const file = this.read();
      const minute = rollover(file.minute[kind], minuteWindow);
      const day = rollover(file.day[kind], dayWindow);

      if (minute.count >= cap.perMinute) {
        throw new ToolError(
          "rate_limited",
          `This server allows ${cap.perMinute} ${kind} calls per minute and that budget is spent. Wait for the next minute.`,
          { kind, window: "minute", cap: cap.perMinute },
        );
      }
      if (day.count >= cap.perDay) {
        throw new ToolError(
          "rate_limited",
          `This server allows ${cap.perDay} ${kind} calls per day and that budget is spent. The counter resets at the next UTC day boundary.`,
          { kind, window: "day", cap: cap.perDay },
        );
      }

      file.minute[kind] = { window: minuteWindow, count: minute.count + 1 };
      file.day[kind] = { window: dayWindow, count: day.count + 1 };
      this.write(file);
    });

    let settled = false;
    return {
      commit: () => {
        settled = true;
      },
      release: () => {
        if (settled) return;
        settled = true;
        try {
          this.locked(() => {
            const file = this.read();
            // Only give back a unit inside the SAME window it was taken from. After a rollover the
            // unit belongs to a window nobody is counting any more, and decrementing the new one
            // would hand out budget that was never spent.
            const minute = file.minute[kind];
            if (minute?.window === minuteWindow && minute.count > 0) minute.count -= 1;
            const day = file.day[kind];
            if (day?.window === dayWindow && day.count > 0) day.count -= 1;
            this.write(file);
          });
        } catch {
          // A release that cannot be written leaves the unit spent. That is the safe direction:
          // over-counting refuses a call the caller could have made, under-counting allows one
          // they could not.
        }
      },
    };
  }

  /** Current usage, for the CLI and the tests. */
  usage(kind: ToolKind): { minute: number; day: number; caps: Caps } {
    const at = this.now().getTime();
    const file = this.locked(() => this.read());
    return {
      minute: rollover(file.minute[kind], Math.floor(at / 60_000)).count,
      day: rollover(file.day[kind], Math.floor(at / 86_400_000)).count,
      caps: this.caps[kind],
    };
  }

  private locked<T>(critical: () => T): T {
    try {
      // Before the lock, because the lock is itself a directory in this home: a home that is not
      // this user's own 0700 directory must be refused rather than have state created inside it.
      ensureDir(this.home);
      return withLock(counterLockPath(this.home), critical, {
        ...(this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs }),
      });
    } catch (err) {
      if (err instanceof ToolError) throw err; // The critical section's own refusal, not a lock failure.
      if (err instanceof LockTimeoutError) {
        throw new ToolError(
          "rate_limited",
          "Another process is updating this server's rate-limit counters and did not finish in time, so this call is refused rather than counted twice. Retry in a moment.",
          { cause: err.message },
        );
      }
      throw this.storeError(counterLockPath(this.home), err);
    }
  }

  private read(): CounterFile {
    const file = counterPath(this.home);
    let raw: string;
    try {
      // A counter store that is not a plain file is not a counter store; following a symlink here
      // would count against whatever it points at.
      if (fs.existsSync(file) && !isRegularFile(file)) {
        throw new Error("the counter file is not a regular file");
      }
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      // A missing file is the normal first call, not a broken store.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw this.storeError(file, err);
    }
    try {
      return parseCounterFile(raw);
    } catch (err) {
      // Corrupt bookkeeping is not the same as no bookkeeping: refuse rather than reset to zero,
      // which is what an attacker who can truncate the file would want. Nothing here writes.
      throw this.storeError(file, err);
    }
  }

  private write(file: CounterFile): void {
    const target = counterPath(this.home);
    try {
      ensureDir(path.dirname(target));
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      secureFile(tmp);
      fs.renameSync(tmp, target);
      secureFile(target);
    } catch (err) {
      // An insecure-state refusal already says exactly what is wrong with which path; restating it
      // as "the store is unusable" would replace the diagnosis with a guess.
      if (err instanceof ToolError) throw err;
      throw this.storeError(target, err);
    }
  }

  private storeError(file: string, cause: unknown): ToolError {
    return new ToolError(
      "policy_denied",
      `The rate-limit store at ${file} is unusable, so this call is refused. This server fails closed: a budget it cannot count is a budget it cannot enforce. Make the directory writable (or point RFPHUB_MCP_HOME somewhere that is) and retry.`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

/**
 * The bucket to count in for `window`, given what is on disk.
 *
 * A stored window AHEAD of the current one means the clock went backwards — an NTP correction, a
 * VM resumed from a snapshot, or somebody buying budget with `date`. The stored bucket is kept and
 * counted in, so no call is granted by moving the clock; the cost is that budget stays spent until
 * real time catches up, which is the safe direction for a limiter.
 */
function rollover(bucket: Bucket | undefined, window: number): Bucket {
  if (bucket === undefined) return { window, count: 0 };
  if (bucket.window > window) return bucket;
  if (bucket.window < window) return { window, count: 0 };
  return bucket;
}

class CounterFileError extends Error {}

function fail(what: string): never {
  throw new CounterFileError(`the counter file is corrupt: ${what}`);
}

/**
 * Parse the whole counter file, or refuse it.
 *
 * NOTHING HERE IS TOLERANT. A negative count hands out extra budget; a string count concatenates
 * instead of adding, so the cap is never reached; a bucket under an unknown kind is a file this
 * build cannot reason about. Every one of those has to reach `storeError` — which denies the call
 * and leaves the file untouched — rather than being normalized into something countable.
 */
export function parseCounterFile(raw: string): CounterFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("it is not valid JSON");
  }
  if (!isPlainObject(parsed)) fail("its root is not an object");
  for (const key of Object.keys(parsed)) {
    if (key !== "minute" && key !== "day") fail(`it has an unexpected \`${key}\` record`);
  }
  return { minute: parseRecord(parsed.minute, "minute"), day: parseRecord(parsed.day, "day") };
}

function parseRecord(value: unknown, name: string): Partial<Record<ToolKind, Bucket>> {
  if (!isPlainObject(value)) fail(`its \`${name}\` record is missing or is not an object`);
  const out: Partial<Record<ToolKind, Bucket>> = {};
  for (const [kind, bucket] of Object.entries(value)) {
    if (!TOOL_KINDS.includes(kind as ToolKind)) fail(`\`${name}\` names an unknown kind`);
    if (!isPlainObject(bucket)) fail(`\`${name}\` holds something that is not a bucket`);
    for (const key of Object.keys(bucket)) {
      if (key !== "window" && key !== "count") fail(`a \`${name}\` bucket has an extra member`);
    }
    if (!isCount(bucket.window) || !isCount(bucket.count)) {
      fail(`a \`${name}\` bucket's window or count is not a whole number of at least zero`);
    }
    out[kind as ToolKind] = { window: bucket.window, count: bucket.count };
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Finite, integral, non-negative and inside the range arithmetic on it stays exact. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
