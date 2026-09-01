/**
 * Rate caps per TOOL KIND, counted locally on disk, under a cross-process lock.
 *
 * Read-modify-write without a lock is not a counter: two processes that both read 4 and both write
 * 5 have let two calls through a cap of five — and an MCP client and a terminal running this same
 * package share one home directory by design.
 *
 * FAIL-CLOSED throughout: a store that cannot be read, written or believed denies the call.
 *
 * The kind is a property of the INVOCATION, not of the tool. `submit_opportunity` is `preview` on
 * its first call and `commit` on its second, and only when that reaches the POST.
 */
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { LockTimeoutError, withLock } from "./lock.js";
import { ensureDir, isRegularFile, secureFile } from "./state.js";

/** `attempt` is not a phase: it meters every write invocation, so the refusal path is not free. */
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

/** Budget is reserved before the human's approval is claimed, because the approval is scarcer. */
export interface Reservation {
  /** Keep the unit spent. Idempotent. */
  commit(): void;
  /** Give it back, because the work never happened. Idempotent. */
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

  /** Spent on disk immediately: a reservation that did not write would be the very race the
   * lock exists to close. */
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
            // Only inside the SAME window it was taken from: after a rollover, decrementing the
            // new window hands out budget nobody spent.
            const minute = file.minute[kind];
            if (minute?.window === minuteWindow && minute.count > 0) minute.count -= 1;
            const day = file.day[kind];
            if (day?.window === dayWindow && day.count > 0) day.count -= 1;
            this.write(file);
          });
        } catch {
          // Leaves the unit spent, which is the safe direction.
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
      // Before the lock, which is itself a directory inside this home.
      ensureDir(this.home);
      return withLock(counterLockPath(this.home), critical, {
        ...(this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs }),
      });
    } catch (err) {
      if (err instanceof ToolError) throw err; // The critical section's own refusal.
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
      // Following a symlink here would count against whatever it points at.
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
      // Corrupt bookkeeping is not no bookkeeping: refuse rather than reset to zero. No write.
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
      // An insecure-state refusal already names the path and the problem.
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

/** A stored window AHEAD of `window` means the clock went backwards: keep the count, so moving
 * a clock grants nothing. */
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
 * NOTHING HERE IS TOLERANT: a negative count hands out budget, a string count concatenates instead
 * of adding, and every failure must reach `storeError` rather than be normalized into a number.
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

/** Finite, integral, non-negative, and inside exact-arithmetic range. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
