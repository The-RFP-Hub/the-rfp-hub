/**
 * The pure half of the scheduled jobs: the catalogue, the lock key, and the provider projection.
 *
 * Everything here runs without a database and without a network. What needs either — the two
 * staleness passes, the advisory lock actually excluding a second run, the admin route's
 * credential matrix — is in `test/integration/jobs.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readUser } from "../../src/modules/services/jobs/account-enrichment.service.js";
import { advisoryLockKey } from "../../src/modules/services/jobs/lock.js";
import { JOBS, JOB_NAMES, findJob } from "../../src/modules/services/jobs/registry.js";

describe("the job catalogue", () => {
  it("names every job exactly once", () => {
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it("carries the six jobs the schedule and the docs name", () => {
    expect([...JOB_NAMES].sort()).toEqual([
      "account-enrichment",
      "analytics-rollup",
      "embedding-backfill",
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

describe("reading the identity provider's user record", () => {
  it("takes the first wallet and the first email from the linked accounts", () => {
    expect(
      readUser({
        linked_accounts: [
          { type: "email", address: "someone@example.org" },
          { type: "wallet", address: "0xAbC0000000000000000000000000000000000001" },
          { type: "wallet", address: "0xdef0000000000000000000000000000000000002" },
        ],
      }),
    ).toEqual({
      // Lower-cased: an address is case-insensitive in every form that matters, and
      // BOOTSTRAP_ADMIN_WALLETS is compared against it flat.
      primaryWallet: "0xabc0000000000000000000000000000000000001",
      email: "someone@example.org",
    });
  });

  it("reports nulls rather than throwing on a shape it does not recognise", () => {
    const nothing = { primaryWallet: null, email: null };
    expect(readUser({})).toEqual(nothing);
    expect(readUser(null)).toEqual(nothing);
    expect(readUser({ linked_accounts: "not-an-array" })).toEqual(nothing);
    expect(
      readUser({ linked_accounts: [{ type: "wallet" }, { type: "wallet", address: "  " }] }),
    ).toEqual(nothing);
  });
});
