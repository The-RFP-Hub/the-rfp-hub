/**
 * The whole nightly chain as ONE invocation, with the ordering held in this process.
 *
 * `docs/jobs.md` §4d has always stated the chain's one rule — everything else, then `staleness` —
 * and then asked a scheduler outside this repository to hold it. That is a rule living in prose,
 * enforced by nobody, in a place this repository cannot read: a caller that reorders the steps, or
 * starts them on a timer instead of on exit, breaks it silently and every run still reports green.
 * `runChain` moves the rule to where it can be checked, and `jobs.js all` is what a scheduler
 * should call instead of five tasks it has to sequence itself.
 *
 * TWO DECISIONS MAKE IT USEFUL RATHER THAN JUST SHORTER.
 *
 * 1. **A throwing job does not end the chain.** `staleness` is last precisely because it depends on
 *    what runs before it, and "depends on" means it needs those jobs to have EXITED — not to have
 *    succeeded. A failed `embedding-backfill` says nothing about whether a past-due entry should be
 *    closed tonight, and skipping the pass the open-data export reads at 03:17 would publish a
 *    dataset advertising programmes that are over. So every job in the chain is attempted, and the
 *    failure is carried in the result instead of in the control flow.
 *
 * 2. **The exit code still tells the truth.** A chain in which anything threw exits 1, so the run
 *    is red and somebody looks. Skips are not failures and never have been — a job whose feature is
 *    off, or one that found its advisory lock held, exits 0 here exactly as it does alone.
 *
 * The per-name advisory lock is unchanged and still per job: `runChain` takes no lock of its own,
 * so two overlapping chains still interleave (§4d's walk-through). What this removes is the class
 * of interleaving caused by a caller getting the order wrong, which was the more likely one.
 */
import { CHAIN, type JobShape, findJob } from "./registry.js";
import { type JobRunReport, type RunJobOptions, runJob } from "./runner.js";

/**
 * One job's line in the chain's result.
 *
 * Deliberately a `JobRunReport` with one optional key added, so a parser written against a single
 * job's `--json` object reads an element of the chain's array without changing: `job`, `shape`,
 * `processed`, `remaining`, `passes` and `elapsedMs` are always present, and `error` appears only
 * on the job that threw.
 */
export interface ChainJobReport extends JobRunReport {
  /** The thrown error's message. Present ONLY when this job failed. */
  error?: string;
}

export interface ChainResult {
  /** One entry per job, in the order they ran. */
  reports: ChainJobReport[];
  /** The names that threw, in order. Empty means the chain exits 0. */
  failed: string[];
}

export interface RunChainOptions extends RunJobOptions {
  /** The sequence to run. Defaults to `CHAIN`; the suite passes its own to fake a catalogue. */
  chain?: readonly string[];
  /** How one job is run. Defaults to `runJob`; the suite injects a runner that throws. */
  run?: (name: string, options: RunJobOptions) => Promise<JobRunReport>;
  /** Called as each job finishes, so a task log streams rather than appearing all at once. */
  onReport?: (report: ChainJobReport) => void;
}

/**
 * Run every job in `chain`, in order, one at a time.
 *
 * Sequential on purpose. The jobs before `staleness` are independent and could overlap, but they
 * share one database and one container's CPU, and a chain that runs them together to save minutes
 * spends those minutes competing for the connection pool the API is also using. The chain has just
 * over two hours of margin before the export publishes; it does not need the minutes.
 */
export async function runChain(options: RunChainOptions = {}): Promise<ChainResult> {
  const { chain = CHAIN, run = runJob, onReport, ...jobOptions } = options;
  const reports: ChainJobReport[] = [];
  const failed: string[] = [];

  for (const name of chain) {
    const startedAt = Date.now();
    let report: ChainJobReport;
    try {
      report = await run(name, jobOptions);
    } catch (error) {
      failed.push(name);
      report = {
        job: name,
        // A job that threw still has to report a shape, or a parser reading the array finds one
        // element shaped differently from the rest. It comes from the catalogue rather than the
        // failed run, which never got far enough to have one.
        shape: shapeOf(name),
        processed: 0,
        remaining: 0,
        passes: 0,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    reports.push(report);
    onReport?.(report);
  }

  return { reports, failed };
}

/** `cursor` for a name the catalogue does not know — only reachable through an injected chain. */
function shapeOf(name: string): JobShape {
  return findJob(name)?.shape ?? "cursor";
}
