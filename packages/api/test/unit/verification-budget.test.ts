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
  limit: 500,
  processed: 0,
  unsettled: 0,
  owed: 0,
  pacedMs: 0,
  pruned: 0,
};

describe("the verification backfill's budget report", () => {
  it("reports remaining: 0 when the selection filled the cap, and defers the true figure", () => {
    const report = batchReport({ ...outcome, selected: 500, processed: 500, owed: 1_200 });
    // Zero here means "do not come round again tonight" — the twenty-pass loop stops at one.
    expect(report.remaining).toBe(0);
    expect(report.details?.deferred, "the number is not lost, only demoted").toBe(1_200);
    expect(report.processed).toBe(500);
  });

  it("reports the honest count when the cap did not bite", () => {
    const report = batchReport({ ...outcome, selected: 12, processed: 9, unsettled: 3, owed: 3 });
    expect(report.remaining).toBe(3);
    expect(report.details?.deferred).toBe(0);
  });

  it("treats a selection that exactly filled the cap as spent, however little is left", () => {
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
      owed: 0,
      pacedMs: 39_000,
      pruned: 12,
    });
    expect(report.details).toEqual({
      selected: 40,
      unsettled: 3,
      deferred: 0,
      pacedMs: 39_000,
      pruned: 12,
    });
  });
});
