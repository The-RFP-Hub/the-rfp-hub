/**
 * M3-6 — entries close themselves when they stop being live, and the job that does it is safe to
 * start twice.
 *
 * Fixtures are aged by writing timestamps directly (`src/db-seed.ts`). That is the only way: the
 * write path stamps `last_seen_at` and `updated_at` on every touch, and there is deliberately no
 * route that moves either backwards — one would be an endpoint for falsifying an entry's history.
 *
 * The nightly schedule itself is untested by design. It is a workflow definition, not behaviour of
 * this system; what matters is that the job it invokes does the right thing when invoked, which is
 * what runs here.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { ageEntry } from "../src/db-seed.js";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

/**
 * The advisory-lock key for a job, derived exactly as `services/jobs/lock.ts` derives it.
 *
 * Mirrored rather than imported, for the same reason as the API-key format in `db-seed.ts`: that
 * module is in another package's `src`. The mirror is self-checking — if it drifted, the lock this
 * test takes would not be the job's lock, and the job would run instead of reporting `locked`,
 * which is the assertion.
 */
function advisoryLockKey(job: string): string {
  const digest = createHash("sha256").update(`rfphub:job:${job}`).digest();
  return (digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn).toString();
}

test.describe("M3-6 what closes and what does not", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "admin");
  });

  test("a past deadline closes the entry, and the closure is audited as the job's own act", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `pastdue-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    // The deadline is written afterwards rather than submitted: the fixture stays a plain, valid
    // document, and the past date lands on the stored `deadlines[]` — which is what the job reads.
    await ageEntry(db, id, { deadlineDaysFromNow: -30 });

    const run = await (await api("admin")).post<{ job: string; processed: number }>(
      "/v1/admin/jobs/staleness/run",
      {},
    );
    expect(run.status).toBe(200);
    expect(run.body.job).toBe("staleness");

    const row = await db.query<{ status: string }>(
      "SELECT status FROM opportunities WHERE public_id = $1",
      [id],
    );
    expect(row.rows[0]?.status).toBe("closed");

    const audit = await db.query<{
      actor_kind: string;
      actor_account_id: string | null;
      patch: { reason?: string };
    }>(
      `SELECT a.actor_kind, a.actor_account_id, a.patch FROM audit_log a
         JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'close'`,
      [id],
    );
    expect(audit.rowCount, "the closure is recorded exactly once").toBe(1);
    // A job acts on nobody's behalf, and the trail has to say so: attributing an automatic closure
    // to whichever administrator happened to press the button would be a false record.
    expect(audit.rows[0]?.actor_kind).toBe("job");
    expect(audit.rows[0]?.actor_account_id).toBeNull();
    expect(audit.rows[0]?.patch?.reason).toBe("past_due");
  });

  test("long inactivity closes an entry with no deadline", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `inactive-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    await ageEntry(db, id, {
      deadlineDaysFromNow: null,
      lastSeenDaysAgo: 100,
      updatedDaysAgo: 100,
    });

    expect((await (await api("admin")).post("/v1/admin/jobs/staleness/run", {})).status).toBe(200);

    const row = await db.query<{ status: string }>(
      "SELECT status FROM opportunities WHERE public_id = $1",
      [id],
    );
    expect(row.rows[0]?.status).toBe("closed");

    const audit = await db.query<{ patch: { reason?: string } }>(
      `SELECT a.patch FROM audit_log a JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'close'`,
      [id],
    );
    expect(audit.rows[0]?.patch?.reason).toBe("inactive");
  });

  test("a recently-seen entry and a future deadline both stay open", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const stamp = Date.now();

    const fresh = opportunityFixture(stack.namespaces.publisher, `fresh-${stamp}`);
    expect((await publisher.post("/v1/opportunities", fresh)).status).toBe(201);
    await ageEntry(db, fresh.id as string, { deadlineDaysFromNow: null, lastSeenDaysAgo: 0 });

    const future = opportunityFixture(stack.namespaces.publisher, `future-${stamp}`);
    expect((await publisher.post("/v1/opportunities", future)).status).toBe(201);
    await ageEntry(db, future.id as string, { deadlineDaysFromNow: 30, lastSeenDaysAgo: 100 });

    expect((await (await api("admin")).post("/v1/admin/jobs/staleness/run", {})).status).toBe(200);

    for (const [label, id] of [
      ["a recently-seen entry", fresh.id as string],
      // A future deadline outranks inactivity: a programme that opens next quarter is not stale.
      ["an entry with a future deadline", future.id as string],
    ] as const) {
      const row = await db.query<{ status: string }>(
        "SELECT status FROM opportunities WHERE public_id = $1",
        [id],
      );
      expect(row.rows[0]?.status, `${label} must stay open`).toBe("open");
    }
  });

  test("a second run changes nothing and adds no second closure", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `idempotent-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    await ageEntry(db, id, { deadlineDaysFromNow: -10 });

    const admin = await api("admin");
    expect((await admin.post("/v1/admin/jobs/staleness/run", {})).status).toBe(200);
    const afterFirst = await db.query<{ updated_at: Date }>(
      "SELECT updated_at FROM opportunities WHERE public_id = $1",
      [id],
    );

    expect((await admin.post("/v1/admin/jobs/staleness/run", {})).status).toBe(200);
    const afterSecond = await db.query<{ updated_at: Date }>(
      "SELECT updated_at FROM opportunities WHERE public_id = $1",
      [id],
    );

    // A job that re-touched every already-closed entry would churn `updated_at` nightly, and every
    // consumer watching that column for real change would see noise forever.
    expect(afterSecond.rows[0]?.updated_at.getTime()).toBe(
      afterFirst.rows[0]?.updated_at.getTime(),
    );

    const closures = await db.query(
      `SELECT 1 FROM audit_log a JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'close'`,
      [id],
    );
    expect(closures.rowCount, "one entry closes once").toBe(1);
  });
});

test.describe("M3-6 who may run a job, and when", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "admin", "publisher");
  });

  test("a concurrent runner is declined rather than queued behind the first", async ({
    stack,
    api,
  }) => {
    // A separate CONNECTION holds the lock, because a session-level advisory lock belongs to the
    // connection that took it — taking it through the shared pool would release it somewhere else.
    const holder = new pg.Client({ connectionString: stack.db.adminUrl });
    await holder.connect();
    try {
      const taken = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [advisoryLockKey("staleness")],
      );
      expect(taken.rows[0]?.locked, "the test must actually hold the lock").toBe(true);

      const contended = await (await api("admin")).post<{ skipped?: string }>(
        "/v1/admin/jobs/staleness/run",
        {},
      );
      // 200 with `skipped`, not an error and not a wait: a run that correctly declined to start is
      // not a failed run, and blocking would mean the second run starts the moment the first ends —
      // the opposite of skipping.
      expect(contended.status).toBe(200);
      expect(contended.body.skipped).toBe("locked");

      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryLockKey("staleness")]);

      const afterRelease = await (await api("admin")).post<{ skipped?: string }>(
        "/v1/admin/jobs/staleness/run",
        {},
      );
      expect(afterRelease.status).toBe(200);
      expect(
        afterRelease.body.skipped,
        "releasing the lock lets the next run proceed",
      ).toBeUndefined();
    } finally {
      await holder.end().catch(() => undefined);
    }
  });

  test("a key cannot run a job", async ({ keyClient }) => {
    // Independent of role, and therefore runnable at every identity count: the key belongs to an
    // account that IS permitted to run jobs, and is refused anyway because it is a key.
    const key = await keyClient("publisher", ["read", "write", "publish"]);
    const withKey = await key.client.post<{ error: string }>("/v1/admin/jobs/staleness/run", {});
    expect(withKey.status).toBe(403);
    expect(withKey.body.error).toBe("session_required");
  });

  test("a session without the administrator role cannot run a job", async ({ stack, api }) => {
    // This half needs an account that is genuinely NOT an administrator. Where the tenant provides
    // only one identity, the publisher IS the bootstrap admin — the route then answers 200, which is
    // correct behaviour and not something to assert around. Gated rather than adjusted.
    test.skip(
      stack.actors.publisher?.aliasGroup === "privileged",
      "BLOCKED: the publisher is also the administrator in this run, so there is no unprivileged " +
        "session to be refused.",
    );

    const publisher = await api("publisher");
    const withoutRole = await publisher.post<{ error: string }>("/v1/admin/jobs/staleness/run", {});
    expect(withoutRole.status).toBe(403);
    expect(withoutRole.body.error).toBe("forbidden");
  });

  test("an unknown job name is refused", async ({ api }) => {
    const admin = await api("admin");
    const unknown = await admin.post<{ error: string }>("/v1/admin/jobs/nope/run", {});
    // The route's own schema enumerates the job names, so an unknown one never reaches a handler.
    expect(unknown.status).toBe(400);
  });
});
