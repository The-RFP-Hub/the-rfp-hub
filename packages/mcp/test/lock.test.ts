/**
 * The cap has to hold against a SECOND PROCESS, because that is the case it exists for: an MCP
 * client and a terminal running this same package share one home directory by design.
 *
 * A read-modify-write without a lock passes an in-process test and fails here — two processes both
 * read `0`, both find it under the cap, and both write `1`, so a cap of one lets two calls through.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LockTimeoutError, withLock } from "../src/lock.js";
import { DEFAULT_CAPS, Policy, counterLockPath, counterPath } from "../src/policy.js";
import { testConfig } from "./helpers.js";

const DIST = path.resolve(import.meta.dirname, "../dist/index.cjs");

function requireBuilt(): void {
  if (!fs.existsSync(DIST)) {
    throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` before this suite");
  }
}

/**
 * Spend `attempts` units of `read` budget from N separate processes at once, against a cap of
 * `cap`, and report how many each process got.
 */
function contend(home: string, cap: number, workers: number, attempts: number): number {
  requireBuilt();
  const script = `
    const { Policy } = require(process.argv[1]);
    const policy = new Policy(process.argv[2], {
      caps: { read: { perMinute: ${cap}, perDay: ${cap} },
              preview: { perMinute: ${cap}, perDay: ${cap} },
              commit: { perMinute: ${cap}, perDay: ${cap} } },
    });
    let ok = 0;
    for (let i = 0; i < ${attempts}; i++) {
      try { policy.consume("read"); ok++; } catch { /* refused, which is the point */ }
    }
    process.stdout.write(String(ok));
  `;
  const results = Array.from({ length: workers }, () =>
    execFileSync("node", ["-e", script, DIST, home], { encoding: "utf8" }),
  );
  return results.reduce((sum, out) => sum + Number(out), 0);
}

describe("withLock", () => {
  it("runs the critical section and cleans the lock up", () => {
    const dir = path.join(testConfig().home, "some.lock");
    const seen = withLock(dir, () => "ran");
    expect(seen).toBe("ran");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("releases the lock even when the critical section throws", () => {
    const dir = path.join(testConfig().home, "some.lock");
    expect(() =>
      withLock(dir, () => {
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses to wait forever on a lock somebody else holds", () => {
    const dir = path.join(testConfig().home, "held.lock");
    fs.mkdirSync(dir, { recursive: true });
    expect(() => withLock(dir, () => 1, { timeoutMs: 30, staleMs: 60_000 })).toThrow(
      LockTimeoutError,
    );
  });

  it("breaks a lock left behind by a process that died", () => {
    const dir = path.join(testConfig().home, "stale.lock");
    fs.mkdirSync(dir, { recursive: true });
    // A crash between acquire and release must not brick the install for good.
    expect(withLock(dir, () => "recovered", { staleMs: 0, timeoutMs: 500 })).toBe("recovered");
  });
});

describe("counters under contention", () => {
  it("lets exactly N calls through a cap of N, across four processes", () => {
    const home = testConfig().home;
    const cap = 5;
    // 4 processes × 5 attempts = 20 tries at a budget of 5. Without a cross-process lock the
    // interleaved read-modify-write hands out more than 5.
    const granted = contend(home, cap, 4, 5);
    expect(granted).toBe(cap);
  });

  it("leaves the counter file agreeing with what it handed out", () => {
    const home = testConfig().home;
    const granted = contend(home, 3, 3, 4);
    const file = JSON.parse(fs.readFileSync(counterPath(home), "utf8")) as {
      day: { read: { count: number } };
    };
    expect(granted).toBe(3);
    expect(file.day.read.count).toBe(3);
  });

  it("leaves no lock directory behind", () => {
    const home = testConfig().home;
    contend(home, 2, 2, 2);
    expect(fs.existsSync(counterLockPath(home))).toBe(false);
  });
});

describe("reservations", () => {
  const NOW = new Date("2026-06-01T12:00:00Z");

  it("spend a unit up front and keep it once committed", () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    const reservation = policy.reserve("commit");
    expect(policy.usage("commit").day).toBe(1);
    reservation.commit();
    expect(policy.usage("commit").day).toBe(1);
  });

  it("give the unit back on release, so a local refusal costs nothing", () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    policy.reserve("commit").release();
    expect(policy.usage("commit").day).toBe(0);
    expect(policy.usage("commit").minute).toBe(0);
  });

  it("ignore a release after a commit, and a second release", () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    const reservation = policy.reserve("commit");
    reservation.commit();
    reservation.release();
    reservation.release();
    expect(policy.usage("commit").day).toBe(1);
  });

  it("never refund into a window the unit was not taken from", () => {
    const home = testConfig().home;
    let now = NOW;
    const policy = new Policy(home, { now: () => now });
    const stale = policy.reserve("commit");

    // The minute rolls over, and a second call spends a unit of the NEW minute's budget.
    now = new Date(NOW.getTime() + 90_000);
    policy.consume("commit");
    expect(policy.usage("commit").minute).toBe(1);

    // Releasing the old reservation must not touch it. A refund that decremented whatever bucket
    // happened to be current would hand out budget nobody ever spent.
    stale.release();
    expect(policy.usage("commit").minute).toBe(1);
  });

  it("still enforce the cap when every unit is committed", () => {
    const home = testConfig().home;
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, commit: { perMinute: 2, perDay: 2 } },
      now: () => NOW,
    });
    policy.reserve("commit").commit();
    policy.reserve("commit").commit();
    expect(() => policy.reserve("commit")).toThrowError(/budget is spent/);
  });
});
