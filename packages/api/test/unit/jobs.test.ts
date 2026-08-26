/**
 * The pure half of the scheduled jobs: the catalogue and the lock key.
 *
 * Everything here runs without a database and without a network. What needs either — the two
 * staleness passes, the advisory lock actually excluding a second run, the admin route's
 * credential matrix — is in `test/integration/jobs.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { runChain } from "../../src/modules/services/jobs/chain.js";
import { advisoryLockKey } from "../../src/modules/services/jobs/lock.js";
import { CHAIN, JOBS, JOB_NAMES, findJob } from "../../src/modules/services/jobs/registry.js";
import type { JobRunReport, RunJobOptions } from "../../src/modules/services/jobs/runner.js";

describe("the job catalogue", () => {
  it("names every job exactly once", () => {
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it("carries every job the schedules and docs name", () => {
    expect([...JOB_NAMES].sort()).toEqual([
      "analytics-rollup",
      "embedding-backfill",
      "notification-dispatch",
      "retention",
      "staleness",
      "verification-backfill",
    ]);
  });

  it("declares a shape and a description for each", () => {
    for (const job of JOBS) {
      expect(["cursor", "sweep"], job.name).toContain(job.shape);
      expect(job.describes.length, job.name).toBeGreaterThan(20);
    }
  });

  /**
   * The sweeps are named here rather than derived, because getting this wrong is the failure mode
   * the shape exists to prevent: a sweep re-selects a fixed window, so a runner that looped it
   * would never terminate. If a job moves between the two, this test is the place that has to be
   * argued with.
   */
  it("marks the two window-reprocessing jobs as sweeps and everything else as a cursor", () => {
    const sweeps = JOBS.filter((job) => job.shape === "sweep").map((job) => job.name);
    expect(sweeps.sort()).toEqual(["analytics-rollup", "retention"]);
  });

  /**
   * `retention` is no longer a job of its own — the prune runs inside `analytics-rollup`. The name
   * is kept for one release because the nightly chain is scheduled OUTSIDE this repository, and a
   * caller still naming it would otherwise exit 2 rather than get its work done.
   */
  it("keeps `retention` as a deprecated alias, and marks nothing else deprecated", () => {
    expect(findJob("retention")?.deprecatedFor).toBe("analytics-rollup");
    expect(JOBS.filter((job) => job.deprecatedFor !== undefined).map((job) => job.name)).toEqual([
      "retention",
    ]);
  });

  it("resolves a known name and refuses an unknown one", () => {
    expect(findJob("staleness")?.shape).toBe("cursor");
    expect(findJob("Staleness")).toBeUndefined();
    expect(findJob("drop-everything")).toBeUndefined();
  });
});

describe("the advisory lock key", () => {
  it("is stable for a name across processes", () => {
    expect(advisoryLockKey("staleness")).toBe(advisoryLockKey("staleness"));
  });

  it("separates the jobs, so one never excludes another", () => {
    const keys = JOB_NAMES.map(advisoryLockKey);
    expect(new Set(keys.map(String)).size).toBe(keys.length);
  });

  /**
   * `pg_try_advisory_lock` takes a SIGNED bigint. A key with the top bit set is out of range and
   * fails at run time — in the scheduled task, at 3am, with nothing else to point at.
   */
  it("stays inside the signed 64-bit range for every name", () => {
    const max = 2n ** 63n - 1n;
    for (const name of [...JOB_NAMES, "x", "", "a".repeat(500), "🙂"]) {
      const key = advisoryLockKey(name);
      expect(key >= 0n, name).toBe(true);
      expect(key <= max, name).toBe(true);
    }
  });
});

/**
 * `CHAIN` is what `jobs.js all` runs, and the sequence is the only ordering the nightly work has.
 * Pinned literally rather than derived a second time: a job added to `JOBS` should have to argue
 * with this test about where it belongs in the night, not join the chain by being declared.
 */
describe("the chain", () => {
  it("is the catalogue minus the deprecated aliases, with staleness last", () => {
    expect([...CHAIN]).toEqual([
      "analytics-rollup",
      "embedding-backfill",
      "verification-backfill",
      "notification-dispatch",
      "staleness",
    ]);
  });
});

/**
 * The chain runner, with a fake catalogue and a fake runner: no database, no lock, no jobs.
 *
 * The case that matters is the one the ordering exists for. `staleness` reads what the jobs before
 * it write, so it has to run after they have EXITED — which is not the same as after they have
 * SUCCEEDED. A chain that stopped at the first throw would skip the pass the open-data export reads
 * at 03:17 and publish a dataset advertising programmes that are over, because an unrelated
 * backfill could not reach its provider.
 */
describe("running the chain", () => {
  const fakeChain = ["first", "explodes", "staleness"];

  const fakeRunner = (ran: string[]) => async (name: string, _options: RunJobOptions) => {
    ran.push(name);
    if (name === "explodes") throw new Error("provider refused");
    return {
      job: name,
      shape: "cursor",
      processed: 1,
      remaining: 0,
      passes: 1,
      elapsedMs: 0,
    } satisfies JobRunReport;
  };

  it("runs every job in order and does not stop at one that throws", async () => {
    const ran: string[] = [];
    const { reports, failed } = await runChain({ chain: fakeChain, run: fakeRunner(ran) });

    expect(ran, "order preserved, and nothing skipped").toEqual(fakeChain);
    expect(reports.map((report) => report.job)).toEqual(fakeChain);
    expect(failed).toEqual(["explodes"]);
    expect(reports[2], "staleness still ran after the failure").toMatchObject({
      job: "staleness",
      processed: 1,
    });
  });

  it("reports the failure in the array rather than in the control flow", async () => {
    const { reports } = await runChain({ chain: fakeChain, run: fakeRunner([]) });
    const failure = reports[1];

    // Shape-compatible with a successful entry: a parser written for a single job's `--json`
    // object reads this without a special case, and only `error` tells the two apart.
    expect(failure).toMatchObject({
      job: "explodes",
      shape: "cursor",
      processed: 0,
      remaining: 0,
      passes: 0,
      error: "provider refused",
    });
    expect(typeof failure?.elapsedMs).toBe("number");
    expect(reports[0]?.error).toBeUndefined();
  });

  it("exits 1 only when something threw — a skip is not a failure", async () => {
    const skipping = async (name: string) =>
      ({
        job: name,
        shape: "cursor",
        processed: 0,
        remaining: 0,
        skipped: "locked",
        passes: 0,
        elapsedMs: 0,
      }) satisfies JobRunReport;

    const clean = await runChain({ chain: fakeChain.slice(0, 1), run: skipping });
    expect(clean.failed, "a declined run has not failed").toEqual([]);

    const broken = await runChain({ chain: fakeChain, run: fakeRunner([]) });
    expect(broken.failed.length).toBeGreaterThan(0);
  });

  it("streams each report as it finishes, in order", async () => {
    const seen: string[] = [];
    await runChain({
      chain: fakeChain,
      run: fakeRunner([]),
      onReport: (report) => seen.push(report.job),
    });
    expect(seen).toEqual(fakeChain);
  });
});
