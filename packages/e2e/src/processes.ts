/**
 * Child processes that cannot orphan.
 *
 * THE PROBLEM THIS SOLVES. Every long-lived child this suite starts is a process TREE, not a
 * process: `pnpm` execs a shell which execs `tsx` which forks an esbuild service; `next dev` forks
 * a router worker and a render worker. Killing the pid the runner holds kills the parent and
 * leaves the grandchildren running — still holding the port, still holding a Postgres connection,
 * and invisible to the next run, which then fails to bind and blames itself.
 *
 * So every child is spawned `detached: true`, which puts it in its OWN process group with the
 * child as group leader, and every kill is addressed to `-pgid` — the whole group. The escalation
 * is SIGTERM, then SIGKILL after a grace period, because the API installs a graceful-shutdown
 * handler (`packages/api/src/server.ts`) that deserves the chance to drain the analytics buffer and
 * close the pool, and `next dev` needs a moment to release its `.next` lock.
 *
 * `detached` has a second consequence that has to be handled rather than inherited: a detached
 * child keeps the parent's event loop referenced. Every child is `unref()`d, and the runner's
 * `finally` — not the event loop emptying — is what ends the run.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Thrown when a wait is abandoned because the run was interrupted.
 *
 * A distinct type, not a plain Error: the runner has to tell "the user pressed Ctrl-C" apart from
 * "the dashboard never came up", because the first is not a failure and must not be reported as
 * one — while both take exactly the same teardown path.
 */
export class InterruptedError extends Error {
  readonly interrupted = true;
}

/** True for an error that means the run was interrupted rather than that something went wrong. */
export function isInterrupted(err: unknown): boolean {
  return err instanceof InterruptedError;
}

export interface SpawnOptions {
  /** Human-readable, used in every message about this child. */
  name: string;
  command: string;
  args: string[];
  cwd: string;
  /** Built from `{}` by `env.ts`. Never `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Where this child's combined stdout/stderr is written. */
  logFile: string;
}

export interface ManagedChild {
  name: string;
  pid: number;
  child: ChildProcess;
  logFile: string;
  /** Resolves with the exit code once the process is gone. Never rejects. */
  exited: Promise<number | null>;
  /** Everything the child has written so far, for a failure message. */
  output: () => string;
}

/** How long a process group gets to honour SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5_000;

/**
 * Starts a detached child in its own process group, tee-ing its output to a file and to an
 * in-memory tail.
 *
 * The tail is capped: `next dev` is chatty, and a run that failed after twenty minutes should not
 * hand the reporter fifty megabytes of compile logs. The FILE keeps everything; the tail is what
 * goes into an error message.
 */
export function start(options: SpawnOptions): ManagedChild {
  const log = createWriteStream(options.logFile, { flags: "a", mode: 0o600 });

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) {
    throw new Error(`processes: ${options.name} did not start (no pid)`);
  }

  const TAIL_LIMIT = 64 * 1024;
  let tail = "";
  const capture = (chunk: Buffer | string) => {
    const text = String(chunk);
    log.write(text);
    tail = (tail + text).slice(-TAIL_LIMIT);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      log.end();
      resolve(code);
    });
    child.once("error", () => {
      log.end();
      resolve(null);
    });
  });

  // Detached children reference the parent's event loop; the runner's `finally` decides when the
  // run ends, not an idle loop.
  child.unref();

  return {
    name: options.name,
    pid: child.pid,
    child,
    logFile: options.logFile,
    exited,
    output: () => tail,
  };
}

/**
 * Kills a child's whole process group: SIGTERM, then SIGKILL if it is still there after the grace
 * period. Safe to call on an already-dead child.
 *
 * The negated pid is the point — `process.kill(-pgid, …)` addresses the group, and the group
 * exists because `start` spawned detached. Killing `child.pid` alone would leave the grandchildren
 * described in the header.
 */
export async function stop(managed: ManagedChild): Promise<void> {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) return;

  if (!signalGroup(managed.pid, "SIGTERM")) {
    // The group is already gone (ESRCH). Nothing to wait for.
    return;
  }

  const settled = await Promise.race([
    managed.exited.then(() => "exited" as const),
    delay(TERM_GRACE_MS).then(() => "timeout" as const),
  ]);

  if (settled === "timeout") {
    signalGroup(managed.pid, "SIGKILL");
    await Promise.race([managed.exited, delay(TERM_GRACE_MS)]);
  }
}

export interface RunResult {
  code: number | null;
  output: string;
}

/**
 * A SHORT-LIVED child, run to completion: the migration, the compliance checker, Playwright itself.
 *
 * Still detached and still group-killed on the way out, for the same reason as the long-lived ones
 * — `pnpm` and `tsx` both fork, and an interrupted run must not leave a migration half-way through
 * a transaction with nobody watching. `onStart` hands the caller the handle so an interrupt can
 * reach it.
 */
export async function run(
  options: Omit<SpawnOptions, "logFile"> & { logFile?: string; inheritStdio?: boolean },
  onStart?: (managed: ManagedChild) => void,
): Promise<RunResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) throw new Error(`processes: ${options.name} did not start (no pid)`);

  let output = "";
  if (!options.inheritStdio) {
    const capture = (chunk: Buffer | string) => {
      output += String(chunk);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
  }

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => resolve(null));
  });

  onStart?.({
    name: options.name,
    pid: child.pid,
    child,
    logFile: options.logFile ?? "(inherited)",
    exited,
    output: () => output,
  });

  const code = await exited;
  return { code, output };
}

/**
 * Kills a process group by pid alone, for a process this runner did not spawn.
 *
 * The only caller is the runner's sweep of processes a Playwright WORKER started (see
 * `orphans.ts`), where there is no `ManagedChild` to hold — just a number recorded in a file. The
 * escalation is the same as `stop()`: SIGTERM to the group, SIGKILL after the grace period.
 */
export async function stopGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGTERM")) return;
  if (await waitUntilGone(pid, TERM_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await waitUntilGone(pid, TERM_GRACE_MS);
}

/** Stops every child, in reverse start order, never letting one failure skip the rest. */
export async function stopAll(children: ManagedChild[]): Promise<string[]> {
  const problems: string[] = [];
  for (const managed of [...children].reverse()) {
    try {
      await stop(managed);
    } catch (err) {
      problems.push(`${managed.name}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/**
 * Signals a process group. Returns false when the group no longer exists, which is a normal
 * outcome (the child exited on its own) rather than a failure.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") {
      // Someone else owns part of the group. Fall back to the single pid rather than giving up.
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    throw err;
  }
}

/**
 * Waits for a process group to disappear. Resolves true when it is gone, false on timeout.
 *
 * The teardown proof depends on this being a real answer rather than a snapshot: a group that has
 * been SIGKILLed is gone within milliseconds, but its members are reaped asynchronously, so a
 * single immediate check can see a group that is already dead.
 */
export async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(100);
  }
  return !alive(pid);
}

/** True while the process (or group) still exists — used by the teardown proof in the report. */
export function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits until `probe()` resolves truthy, or gives up.
 *
 * Used for every readiness gate in the run (Postgres accepting connections, the API answering, a
 * Next route compiling). The child is watched WHILE waiting: if it dies, this rejects immediately
 * with its output rather than burning the whole timeout on a process that is never coming back —
 * which is the difference between "the API crashed on a bad DATABASE_URL" and "timed out".
 */
export async function waitFor(options: {
  what: string;
  probe: () => Promise<boolean>;
  timeoutMs: number;
  intervalMs?: number;
  watch?: ManagedChild;
  /**
   * Checked on every poll. Returning true abandons the wait with `InterruptedError`.
   *
   * This is what makes an interrupt during bring-up responsive. The longest waits in a run are
   * readiness gates — `next dev` compiling, the API connecting to a cold database — and without
   * this a Ctrl-C would be recorded and then acted on a minute or two later, once the wait it
   * arrived during had finished on its own.
   */
  abort?: () => boolean;
}): Promise<void> {
  const interval = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (options.abort?.())
      throw new InterruptedError(`interrupted while waiting for ${options.what}`);
    if (options.watch && options.watch.child.exitCode !== null) {
      throw new Error(
        `${options.what}: ${options.watch.name} exited with code ${options.watch.child.exitCode} while waiting.\n` +
          `--- last output from ${options.watch.name} ---\n${options.watch.output()}`,
      );
    }
    try {
      if (await options.probe()) return;
    } catch (err) {
      lastError = err;
    }
    await delay(interval);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  const output = options.watch
    ? `\n--- last output from ${options.watch.name} ---\n${options.watch.output()}`
    : "";
  throw new Error(`${options.what}: not ready after ${options.timeoutMs}ms${detail}${output}`);
}
