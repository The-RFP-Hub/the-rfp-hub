/**
 * The nightly budget, as arithmetic.
 *
 * `remaining` is not a statistic a caller may take or leave — it is an instruction. `runner.ts`
 * loops a cursor job while `processed > 0 && remaining > 0`, and `run-job.ts` allows twenty passes
 * by default, so a job that reports the honest count of what its predicate still matches has
 * authorised twenty times its own cap. The re-check TTL turns that from an occasional problem into
 * a permanent one: the predicate refills on a rolling schedule rather than draining, so `remaining`
 * is positive by design and the loop runs until the PASS budget is spent rather than the work.
 *
 * Driven as a pure function on purpose. The alternative — an unscoped `runBatch` — would fetch and
 * stamp entries belonging to every other suite sharing the test database, and the property under
 * test is arithmetic, not I/O.
 */
import { describe, expect, it } from "vitest";
import { batchReport } from "../../src/modules/services/verification/verification.service.js";

const outcome = {
  selected: 0,
  processed: 0,
  unsettled: 0,
  owed: 0,
  pacedMs: 0,
  pruned: 0,
};

describe("the verification backfill's budget report", () => {
  it("never asks to be looped, and defers the true figure instead", () => {
    const report = batchReport({ ...outcome, selected: 500, processed: 500, owed: 1_200 });
    // Zero here means "do not come round again tonight" — the twenty-pass loop stops at one.
    expect(report.remaining).toBe(0);
    expect(report.details?.deferred, "the number is not lost, only demoted").toBe(1_200);
    expect(report.processed).toBe(500);
  });

  /**
   * THE CASE THAT "report zero only when the cap bit" MISSED, and the reason the rule is
   * unconditional. 499 selected against a 500 limit is a cap that never appears to bite; some rows
   * settled and some left owed by a transient failure is `processed > 0` and `remaining > 0`; and
   * the pass after it is a fresh full budget. A 500 cap bought 997 fetches.
   */
  it("reports zero even when the selection came in UNDER the limit", () => {
    const report = batchReport({
      ...outcome,
      selected: 499,
      processed: 300,
      unsettled: 199,
      owed: 199,
    });
    expect(report.remaining).toBe(0);
    expect(report.details?.deferred).toBe(199);
  });

  it("still says so when nothing at all is left owed", () => {
    const report = batchReport({ ...outcome, selected: 500, processed: 500, owed: 0 });
    expect(report.remaining).toBe(0);
    expect(report.details?.deferred).toBe(0);
  });

  it("carries the per-pass counters a log line and the admin response read", () => {
    const report = batchReport({
      ...outcome,
      selected: 40,
      processed: 37,
      unsettled: 3,
      owed: 5,
      pacedMs: 39_000,
      pruned: 12,
    });
    expect(report.details).toEqual({
      selected: 40,
      unsettled: 3,
      deferred: 5,
      pacedMs: 39_000,
      pruned: 12,
    });
  });
});
