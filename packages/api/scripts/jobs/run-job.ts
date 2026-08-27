#!/usr/bin/env node
/**
 * The scheduled-job entry point.
 *
 * `tsup.config.ts` builds this as `dist/jobs.js`, alongside `migrate`, `seed` and `export`, so the
 * deployed image can run
 *
 *     node packages/api/dist/jobs.js staleness
 *
 * as a one-off container task. THAT IS HOW THE SCHEDULE RUNS JOBS — a workflow starts the task with
 * the deployment's own credentials. There is no public job endpoint and no shared job token: a
 * credential that can start a job would have to live somewhere, and the somewhere is always worse
 * than "the deploy role that already exists".
 *
 * `all` IS THE ONE A SCHEDULER SHOULD CALL. It runs the whole chain in this process, in `CHAIN`
 * order, so the ordering the docs used to ask an external caller to hold — everything else, then
 * `staleness` — is now held by the thing that knows what it is for. See `services/jobs/chain.ts`.
 *
 * Exit codes are the contract the workflow reads:
 *   0  the job ran, or declined to run (another run held the lock, or the feature is off)
 *   1  the job threw — for `all`, ANY job in the chain threw
 *   2  the invocation was wrong (unknown job, bad flag, no DATABASE_URL)
 *
 * A run that SKIPPED is deliberately a zero. A scheduled task that correctly declined to start
 * because the previous one is still going has not failed, and paging somebody about it teaches
 * everyone to ignore the alert.
 */
import { config } from "../../src/config.js";
import { pool } from "../../src/db/client.js";
import { type ChainJobReport, runChain } from "../../src/modules/services/jobs/chain.js";
import { CHAIN, JOBS, JOB_NAMES, findJob } from "../../src/modules/services/jobs/registry.js";
import {
  type JobRunReport,
  UnknownJobError,
  runJob,
} from "../../src/modules/services/jobs/runner.js";

const USAGE = `RFP Hub scheduled jobs

  node packages/api/dist/jobs.js all [options]          the whole nightly chain, in order
  node packages/api/dist/jobs.js <job> [options]        one job
  pnpm --filter @the-rfp-hub/api jobs <job> [options]

Jobs
  ${"all".padEnd(22)} ${"chain".padEnd(7)} Run every job below, in order: ${CHAIN.join(", ")}.
${JOBS.map((job) => `  ${job.name.padEnd(22)} ${job.shape.padEnd(7)} ${job.describes}`).join("\n")}

Options
  --limit <n>     Bound on the rows one pass touches (cursor jobs only). Job-specific default.
  --passes <n>    How many times a cursor job may repeat while it is still making progress.
                  Default 20. A sweep always runs exactly once, whatever this says.
  --json          Emit the result as one JSON object instead of a human line — or, for \`all\`, one
                  JSON ARRAY of those same objects, on one line, in the order they ran.
  -h, --help      This text.

Every job takes a database advisory lock on its own name, so a second run of the SAME job while one
is in flight reports {"skipped":"locked"} and exits 0 without waiting. \`all\` runs the chain
sequentially and does NOT stop at a job that throws — staleness has to run after the others have
EXITED, not after they have succeeded — and exits 1 if any of them did. See
packages/api/docs/jobs.md.
`;

/** The one argument that is not a job name. Deliberately not in the catalogue. */
const ALL = "all";

interface Options {
  /** A catalogue name, or `all` for the whole chain. */
  job?: string;
  limit?: number;
  passes: number;
  json: boolean;
  help: boolean;
}

// Deliberately not exported: this module runs `main()` on import, so anything that imported it to
// test the parser would start a job. The catalogue it validates against is what has a unit test.
function parseArgs(argv: string[]): Options {
  const opts: Options = { passes: 20, json: false, help: false };
  const number = (raw: string | undefined, flag: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--limit":
        opts.limit = number(argv[++i], arg);
        break;
      case "--passes":
        opts.passes = number(argv[++i], arg);
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${JSON.stringify(arg)}`);
        if (opts.job !== undefined) throw new Error("name exactly one job");
        opts.job = arg;
    }
  }
  return opts;
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help || opts.job === undefined) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 2;
  }
  if (!config.databaseUrl) {
    process.stderr.write("DATABASE_URL is required to run a job.\n");
    return 2;
  }

  // A deprecated name still does its work — the whole reason it is kept — but says so on stderr,
  // which is where an operator reading a task log will see it and stdout's `--json` will not.
  const deprecatedFor = findJob(opts.job)?.deprecatedFor;
  if (deprecatedFor !== undefined) {
    process.stderr.write(
      `${opts.job} is deprecated and will be removed: ${deprecatedFor} now does this work. See packages/api/docs/jobs.md §1.\n`,
    );
  }

  try {
    if (opts.job === ALL) return await runTheChain(opts);
    const report = await runJob(opts.job, { limit: opts.limit, maxPasses: opts.passes });
    process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : `${humanLine(report)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UnknownJobError) {
      process.stderr.write(`${error.message}. Known jobs: ${ALL}, ${JOB_NAMES.join(", ")}\n`);
      return 2;
    }
    process.stderr.write(`job failed — ${(error as Error)?.stack ?? String(error)}\n`);
    return 1;
  } finally {
    // The task exits when this resolves; leaving the pool open holds the container alive for its
    // idle timeout and holds a connection on a database whose budget is shared.
    await pool.end().catch(() => undefined);
  }
}

/**
 * `all`: the whole chain, and one exit code for it.
 *
 * `--json` emits ONE line holding an ARRAY of the same per-job objects a single run prints, in the
 * order they ran — so a parser that reads a single job's output reads an element of this without
 * being rewritten. Without `--json` each job's line is written as it finishes rather than at the
 * end, because a task log an operator is watching at 01:05 should show where the chain has got to.
 *
 * A job's failure is reported and the chain continues; the exit code is 1 if any of them threw. See
 * `services/jobs/chain.ts` for why continuing is the right answer and not merely the convenient one.
 */
async function runTheChain(opts: Options): Promise<number> {
  const stream = opts.json ? undefined : (report: ChainJobReport) => announce(report);
  const { reports, failed } = await runChain({
    limit: opts.limit,
    maxPasses: opts.passes,
    onReport: stream,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(reports)}\n`);
  } else if (failed.length > 0) {
    process.stdout.write(`chain finished with failures: ${failed.join(", ")}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

/** One finished chain job, human-readable: the line on stdout, the stack on stderr if it threw. */
function announce(report: ChainJobReport): void {
  process.stdout.write(`${humanLine(report)}\n`);
  if (report.error !== undefined) {
    process.stderr.write(`${report.job} failed — ${report.error}\n`);
  }
}

function humanLine(report: JobRunReport & { error?: string }): string {
  return [
    `${report.job} (${report.shape})`,
    report.error !== undefined
      ? `failed: ${report.error}`
      : report.skipped
        ? `skipped: ${report.skipped}`
        : "ok",
    `processed=${report.processed}`,
    `remaining=${report.remaining}`,
    `passes=${report.passes}`,
    ...Object.entries(report.details ?? {}).map(([key, value]) => `${key}=${value}`),
    `${report.elapsedMs}ms`,
  ].join(" ");
}

process.exitCode = await main();
