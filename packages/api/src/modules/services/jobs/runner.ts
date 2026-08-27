/**
 * Running a job by name: the lock, the loop, and the one contract both callers share.
 *
 * Two things start jobs — `scripts/jobs/run-job.ts` (which is what the schedule invokes as a
 * one-off container task) and `POST /v1/admin/jobs/:job/run` (a reviewer's convenience button).
 * Neither may hold a different opinion about what "run the staleness job" means, so both come
 * through here.
 *
 * THE LOOP CONDITION IS `processed > 0 && remaining > 0`, and both halves matter:
 *
 *   - `remaining > 0` stops a SWEEP after exactly one pass without the runner needing to know
 *     which jobs are sweeps. A sweep reports `remaining: 0` by definition (see `types.ts`), so the
 *     rule is structural rather than a list of exceptions that would eventually go stale.
 *   - `processed > 0` stops a cursor job that is no longer making progress. A row that cannot be
 *     embedded, an entry whose source refuses every fetch, an account the provider 429s — each
 *     stays in its predicate, so `remaining` alone would spin forever on a poison row. A pass that
 *     changed nothing is the signal to stop and let the next scheduled run try again.
 *
 * `maxPasses` is the belt to that braces: whatever else is true, the runner stops.
 */
import { LOCKED, withJobLock } from "./lock.js";
import { type JobDefinition, type JobRunOptions, findJob } from "./registry.js";
import type { JobResult } from "./types.js";

export interface RunJobOptions extends JobRunOptions {
  /** How many times a cursor job may go round while it is still making progress. Default 1. */
  maxPasses?: number;
  /**
   * The caller is an HTTP request, so an unnamed `limit` falls back to the job's `interactiveLimit`
   * rather than to the job's own (schedule-sized) default. See `JobDefinition.interactiveLimit`:
   * `verification-backfill` paces itself per host, and its nightly selection is minutes of wall
   * clock that a socket does not have. Set by `POST /v1/admin/jobs/{job}/run` and by nothing else —
   * the CLI and the container task are deliberately not interactive.
   */
  interactive?: boolean;
  /** Overrides the connection the advisory lock is taken on. Tests point this at their instance. */
  lockConnectionString?: string;
}

export interface JobRunReport extends JobResult {
  job: string;
  shape: "cursor" | "sweep";
  passes: number;
  elapsedMs: number;
}

/** Thrown for a name that is not in the catalogue, so both callers can answer 404/usage. */
export class UnknownJobError extends Error {
  constructor(readonly job: string) {
    super(`unknown job ${JSON.stringify(job)}`);
    this.name = "UnknownJobError";
  }
}

/**
 * What one pass may select, once the caller's own opinion and the job's interactive bound have both
 * been heard.
 *
 * A NAMED LIMIT ALWAYS WINS, including one larger than the interactive bound. The bound exists so
 * that a DEFAULT cannot hang a request; a caller that asked for a thousand asked for it, and
 * answering with ten while reporting success would be a quieter failure than a slow response.
 *
 * `undefined` means "the job's own default", which for every cursor job is a number its own service
 * holds — this function does not know or need to know what it is.
 *
 * Pure, and exported, so the rule can be read and tested without an advisory lock or a database.
 */
export function effectiveLimit(job: JobDefinition, options: RunJobOptions): number | undefined {
  if (options.limit !== undefined) return options.limit;
  if (!options.interactive) return undefined;
  return job.interactiveLimit;
}

export async function runJob(name: string, options: RunJobOptions = {}): Promise<JobRunReport> {
  const job = findJob(name);
  if (!job) throw new UnknownJobError(name);
  const maxPasses = Math.max(1, options.maxPasses ?? 1);
  const startedAt = Date.now();
  const limit = effectiveLimit(job, options);
  const runOptions: RunJobOptions = limit === options.limit ? options : { ...options, limit };

  const locked = await withJobLock(
    job.name,
    async () => {
      let processed = 0;
      let passes = 0;
      let last: JobResult = { processed: 0, remaining: 0 };
      const details: Record<string, number> = {};

      while (passes < maxPasses) {
        last = await job.run(runOptions);
        passes++;
        processed += last.processed;
        for (const [key, value] of Object.entries(last.details ?? {})) {
          details[key] = (details[key] ?? 0) + value;
        }
        if (last.skipped !== undefined) break;
        if (last.processed === 0 || last.remaining === 0) break;
      }

      return {
        processed,
        remaining: last.remaining,
        ...(last.skipped === undefined ? {} : { skipped: last.skipped }),
        ...(Object.keys(details).length === 0 ? {} : { details }),
        passes,
      };
    },
    { connectionString: options.lockConnectionString },
  );

  if (!locked.ran || !locked.result) {
    // Not an error. Another run of the same job holds the lock, which is precisely what the lock
    // is for; the caller exits 0 and the schedule moves on.
    return {
      job: job.name,
      shape: job.shape,
      processed: 0,
      remaining: 0,
      skipped: LOCKED,
      passes: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const { passes, ...result } = locked.result;
  return { job: job.name, shape: job.shape, ...result, passes, elapsedMs: Date.now() - startedAt };
}
