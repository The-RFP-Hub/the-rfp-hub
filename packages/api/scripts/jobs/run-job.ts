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
 * Exit codes are the contract the workflow reads:
 *   0  the job ran, or declined to run (another run held the lock, or the feature is off)
 *   1  the job threw
 *   2  the invocation was wrong (unknown job, bad flag, no DATABASE_URL)
 *
 * A run that SKIPPED is deliberately a zero. A scheduled task that correctly declined to start
 * because the previous one is still going has not failed, and paging somebody about it teaches
 * everyone to ignore the alert.
 */
import { config } from "../../src/config.js";
import { pool } from "../../src/db/client.js";
import { JOBS, JOB_NAMES } from "../../src/modules/services/jobs/registry.js";
import { UnknownJobError, runJob } from "../../src/modules/services/jobs/runner.js";

const USAGE = `RFP Hub scheduled jobs

  node packages/api/dist/jobs.js <job> [options]
  pnpm --filter @the-rfp-hub/api jobs <job> [options]

Jobs
${JOBS.map((job) => `  ${job.name.padEnd(22)} ${job.shape.padEnd(7)} ${job.describes}`).join("\n")}

Options
  --limit <n>     Bound on the rows one pass touches (cursor jobs only). Job-specific default.
  --passes <n>    How many times a cursor job may repeat while it is still making progress.
                  Default 20. A sweep always runs exactly once, whatever this says.
  --json          Emit the result as one JSON object instead of a human line.
  -h, --help      This text.

Every job takes a database advisory lock on its own name, so a second run of the SAME job while one
is in flight reports {"skipped":"locked"} and exits 0 without waiting. See packages/api/docs/jobs.md.
`;

interface Options {
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

  try {
    const report = await runJob(opts.job, { limit: opts.limit, maxPasses: opts.passes });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      const line = [
        `${report.job} (${report.shape})`,
        report.skipped ? `skipped: ${report.skipped}` : "ok",
        `processed=${report.processed}`,
        `remaining=${report.remaining}`,
        `passes=${report.passes}`,
        ...Object.entries(report.details ?? {}).map(([key, value]) => `${key}=${value}`),
        `${report.elapsedMs}ms`,
      ].join(" ");
      process.stdout.write(`${line}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UnknownJobError) {
      process.stderr.write(`${error.message}. Known jobs: ${JOB_NAMES.join(", ")}\n`);
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

process.exitCode = await main();
