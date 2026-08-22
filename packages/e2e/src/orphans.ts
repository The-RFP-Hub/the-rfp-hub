/**
 * A file-backed register of processes started by someone other than the runner.
 *
 * WHY THIS HAS TO EXIST. Almost every long-lived process in a run is started by `run.ts`, which
 * holds its handle and kills its whole process group in `finally`. One is not: `ssrf.spec.ts` boots
 * a short-lived second API — with the SSRF address checks left on — inside a Playwright worker,
 * because the assertion is precisely about a configuration the main instance cannot have.
 *
 * That child is invisible to the runner. Its `afterAll` normally stops it, but `afterAll` is exactly
 * what does not run when a worker is killed, crashes, or is interrupted — and those are the cases
 * where cleanup matters most. The result would be an orphaned API server holding a port and a
 * database connection, outliving the run that created it and invisible to the next one.
 *
 * So a worker records the pid here, in the run's own 0700 directory, before it starts waiting on the
 * child. The runner's `finally` reads the file and group-kills anything still alive. Belt and
 * braces: the spec still stops its own child in `afterAll`, and killing an already-dead process
 * group is a no-op.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Points every process in the run at the same register. Set by the runner, read by workers. */
export const ORPHAN_REGISTER_ENV = "E2E_CHILD_PIDS_FILE";

/**
 * Records a pid the runner did not spawn.
 *
 * Called BEFORE the child is waited on, never after: a crash between spawning and registering is
 * the whole scenario this guards against, so the window has to be as close to zero as possible.
 */
export function register(pid: number, what: string): void {
  const path = process.env[ORPHAN_REGISTER_ENV];
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${pid} ${what}\n`, { mode: 0o600 });
}

export interface RegisteredChild {
  pid: number;
  what: string;
}

/** Everything workers registered this run. Missing file means none — not an error. */
export function registered(
  path: string | undefined = process.env[ORPHAN_REGISTER_ENV],
): RegisteredChild[] {
  if (!path) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: RegisteredChild[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pid, ...rest] = trimmed.split(" ");
    const parsed = Number(pid);
    if (Number.isInteger(parsed) && parsed > 0) out.push({ pid: parsed, what: rest.join(" ") });
  }
  return out;
}
