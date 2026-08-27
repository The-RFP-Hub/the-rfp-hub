/**
 * Rate caps per TOOL KIND, counted locally on disk.
 *
 * `read` is generous, `preview` is narrow, `commit` is very narrow. The point of the commit cap is
 * not throughput: it is that a compromised loop which somehow reaches the write path can do it a
 * handful of times a day, not a thousand.
 *
 * FAIL-CLOSED. If the counter store cannot be read or written, the call is DENIED rather than
 * allowed — a limiter that opens when its bookkeeping breaks is not a limiter. The consequence is
 * that `RFPHUB_MCP_HOME` (default `~/.rfphub`) has to be writable; the README says so.
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

export type ToolKind = "read" | "preview" | "commit";

export interface Caps {
  perMinute: number;
  perDay: number;
}

export const DEFAULT_CAPS: Readonly<Record<ToolKind, Caps>> = Object.freeze({
  read: { perMinute: 60, perDay: 5_000 },
  preview: { perMinute: 10, perDay: 200 },
  commit: { perMinute: 2, perDay: 5 },
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

export interface PolicyOptions {
  caps?: Readonly<Record<ToolKind, Caps>>;
  now?: () => Date;
}

export class Policy {
  private readonly home: string;
  private readonly caps: Readonly<Record<ToolKind, Caps>>;
  private readonly now: () => Date;

  constructor(home: string, options: PolicyOptions = {}) {
    this.home = home;
    this.caps = options.caps ?? DEFAULT_CAPS;
    this.now = options.now ?? (() => new Date());
  }

  /** Spend one unit of `kind`'s budget, or throw `rate_limited`. */
  consume(kind: ToolKind): void {
    const cap = this.caps[kind];
    const at = this.now().getTime();
    const minuteWindow = Math.floor(at / 60_000);
    const dayWindow = Math.floor(at / 86_400_000);

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
  }

  /** Current usage, for `rfphub-mcp pending` and the tests. */
  usage(kind: ToolKind): { minute: number; day: number; caps: Caps } {
    const at = this.now().getTime();
    const file = this.read();
    return {
      minute: rollover(file.minute[kind], Math.floor(at / 60_000)).count,
      day: rollover(file.day[kind], Math.floor(at / 86_400_000)).count,
      caps: this.caps[kind],
    };
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
