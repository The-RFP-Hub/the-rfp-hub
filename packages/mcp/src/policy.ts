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
import { ensureDir } from "./approvals.js";
import { ToolError } from "./errors.js";
import { LockTimeoutError, withLock } from "./lock.js";

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
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      // A missing file is the normal first call, not a broken store.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw this.storeError(file, err);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CounterFile>;
      return { minute: parsed.minute ?? {}, day: parsed.day ?? {} };
    } catch {
      // Corrupt bookkeeping is not the same as no bookkeeping: refuse rather than reset to zero,
      // which is what an attacker who can truncate the file would want.
      throw this.storeError(file, new Error("the counter file is not valid JSON"));
    }
  }

  private write(file: CounterFile): void {
    const target = counterPath(this.home);
    try {
      ensureDir(path.dirname(target));
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
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

function rollover(bucket: Bucket | undefined, window: number): Bucket {
  if (bucket === undefined || bucket.window !== window) return { window, count: 0 };
  return bucket;
}
