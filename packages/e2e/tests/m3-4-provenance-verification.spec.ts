/**
 * M3-4 — the audit trail, its redaction, and source verification against a real page over real HTTP.
 *
 * The verification half fetches a page the suite itself serves (`src/fixture-server.ts`), so every
 * assertion about what the verifier requested, what it read and what it computed is checked against
 * a page whose contents this file controls — rather than against a third-party site that can change
 * under the run.
 *
 * The immutability of `audit_log` is asserted at BOTH layers, because they are different guarantees
 * with different failure modes:
 *   - the database trigger from migration 0004 stops any connection, however privileged, from
 *     rewriting history (SQLSTATE 23001, `restrict_violation`, raised with an explicit ERRCODE);
 *   - the REVOKE from `harden-audit.sql` stops the application's own role from even trying
 *     (SQLSTATE 42501, `insufficient_privilege`).
 * Proving one and claiming the other would leave a real gap: a deployment that forgot to run the
 * hardening script still has the trigger, and a database restored without triggers still has the
 * revoke — but only if both were actually applied, which is what these assert.
 */
import { createHash } from "node:crypto";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

/**
 * The byte cap the runner configures on every API instance (`env.ts` → `VERIFY_MAX_BYTES`).
 *
 * Restated here rather than read from the stack because the point of the `/big` assertion is to
 * compare against an INDEPENDENTLY known number; taking it from the same place the API took it from
 * would make the two agree by construction.
 */
const VERIFY_MAX_BYTES = 2 * 1024 * 1024;

/** `restrict_violation` — the explicit ERRCODE migration 0004's trigger raises. */
const AUDIT_TRIGGER_SQLSTATE = "23001";
/** `insufficient_privilege` — what a role without the privilege gets, before any trigger runs. */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = "42501";

test.describe("M3-4 the audit trail", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("a create writes exactly one audit row, in the same transaction, naming the actor", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `audit-${Date.now()}`);
    const id = document.id as string;

    const before = new Date();
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    const after = new Date();

    const rows = await db.query<{
      action: string;
      actor_kind: string;
      actor_account_id: string | null;
      actor_api_key_id: string | null;
      created_at: Date;
    }>(
      `SELECT a.action, a.actor_kind, a.actor_account_id, a.actor_api_key_id, a.created_at
         FROM audit_log a JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'create'`,
      [id],
    );

    expect(rows.rowCount, "exactly one create row — not zero, not two").toBe(1);
    const row = rows.rows[0];
    expect(row?.actor_kind).toBe("user");
    expect(row?.actor_account_id, "a session write names the account").not.toBeNull();
    expect(row?.actor_api_key_id, "a session write names no key").toBeNull();
    // Inside the request window: the row was written by the request, not by a later sweep.
    expect(row?.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    expect(row?.created_at.getTime()).toBeLessThanOrEqual(after.getTime() + 1_000);
  });

  test("a key write names the key that acted", async ({
    stack,
    keyClient,
    db,
    opportunityFixture,
  }) => {
    const key = await keyClient("publisher", ["read", "write", "publish"]);
    const document = opportunityFixture(stack.namespaces.publisher, `keyaudit-${Date.now()}`);
    const id = document.id as string;
    expect((await key.client.post("/v1/opportunities", document)).status).toBe(201);

    const rows = await db.query<{ actor_kind: string; actor_api_key_id: string | null }>(
      // `subject_kind` is part of the key, not decoration: `subject_id` is only unique WITHIN a
      // kind, so a claim row whose id happened to equal this opportunity's would join without it.
      `SELECT a.actor_kind, a.actor_api_key_id FROM audit_log a
         JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'create'`,
      [id],
    );
    expect(rows.rows[0]?.actor_kind).toBe("api_key");
    // WHICH key, not merely "a key". This is the first question asked when a key is suspected of
    // having leaked, and an account id cannot answer it.
    expect(Number(rows.rows[0]?.actor_api_key_id)).toBe(key.keyId);
  });

  test("the diff is redacted for the unauthorized and complete for the entitled", async ({
    stack,
    api,
    anonApi,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `redact-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    expect(
      (
        await publisher.put(`/v1/opportunities/${encodeURIComponent(id)}`, {
          ...document,
          title: "Changed",
        })
      ).status,
    ).toBe(200);

    const anonymous = await anonApi.get<{
      entries: Array<{ changedFields: string[]; patch?: unknown }>;
    }>(`/v1/opportunities/${encodeURIComponent(id)}/audit`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.entries.length).toBeGreaterThan(0);
    for (const entry of anonymous.body.entries) {
      // The public trail says WHAT changed, never what it changed from or to. That distinction is
      // the whole redaction: a field name is accountability, a value is the record's private draft.
      expect(Array.isArray(entry.changedFields)).toBe(true);
      expect(entry.patch, "an anonymous reader never receives values").toBeUndefined();
    }

    const owner = await publisher.get<{ entries: Array<{ patch?: Record<string, unknown> }> }>(
      `/v1/opportunities/${encodeURIComponent(id)}/audit`,
    );
    expect(owner.body.entries.some((entry) => entry.patch !== undefined)).toBe(true);

    const reviewer = await (await api("reviewer")).get<{ entries: Array<{ patch?: unknown }> }>(
      `/v1/opportunities/${encodeURIComponent(id)}/audit`,
    );
    expect(reviewer.body.entries.some((entry) => entry.patch !== undefined)).toBe(true);
  });

  test("the audit of a non-public entry is not readable by a stranger", async ({
    stack,
    api,
    anonApi,
    pendingHeadroom,
    opportunityFixture,
  }) => {
    // Needs an entry that is genuinely not public, which means a submission that cannot auto-publish.
    skipUnlessActor(stack, "submitter");
    // …and an account with no verified membership may have only so many waiting at once. The cap is
    // asserted on its own terms in `m3-1`; here it would just be an unrelated 409, so a slot is
    // freed the way the product frees one.
    await pendingHeadroom("submitter", 1);
    const submitter = await api("submitter");
    const document = opportunityFixture(stack.namespaces.publisher, `hidden-audit-${Date.now()}`);
    const id = document.id as string;
    expect((await submitter.post("/v1/opportunities", document)).status).toBe(201);

    const anonymous = await anonApi.get(`/v1/opportunities/${encodeURIComponent(id)}/audit`);
    // 404, not 403: a 403 would confirm the entry exists, which is the fact being withheld.
    expect(anonymous.status).toBe(404);
  });
});

/**
 * These two need no identity at all — they are about the database, and they run at every ladder
 * level. Each seeds its own row first, and that is not incidental: a row-level trigger does not fire
 * for a statement that matches nothing, so `UPDATE … WHERE id = (SELECT min(id) …)` against an empty
 * table succeeds, and a test written that way reports PASS on a database with no immutability
 * whatsoever. The seeded row is what makes the refusal mean something.
 */
test.describe("M3-4 the audit log cannot be rewritten", () => {
  const seedRow = async (pool: import("pg").Pool, subjectId: number): Promise<void> => {
    await pool.query(
      `INSERT INTO audit_log (subject_kind, subject_id, actor_kind, action)
         VALUES ('opportunity', $1, 'job', 'create')`,
      [subjectId],
    );
  };

  test("the database trigger refuses an update, a delete and a truncate, even as the owner", async ({
    db,
  }) => {
    const subjectId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    await seedRow(db, subjectId);
    const seeded = await db.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE subject_id = $1 LIMIT 1",
      [subjectId],
    );
    const rowId = seeded.rows[0]?.id;
    expect(rowId, "the seeded row must exist, or the statements below match nothing").toBeDefined();

    for (const [statement, values] of [
      ["UPDATE audit_log SET action = 'update' WHERE id = $1", [rowId]],
      ["DELETE FROM audit_log WHERE id = $1", [rowId]],
      ["TRUNCATE audit_log", []],
    ] as const) {
      const failure = await db.query(statement, [...values]).then(
        () => undefined,
        (err: { code?: string }) => err,
      );
      expect(failure, `"${statement}" must be refused`).toBeDefined();
      expect(
        (failure as { code?: string }).code,
        `"${statement}" must hit the immutability trigger`,
      ).toBe(AUDIT_TRIGGER_SQLSTATE);
    }
  });

  test("the runtime role has no privilege to try, and can still write and read the trail", async ({
    restrictedDb,
  }) => {
    // The role the API runs on must be able to do its job: a role that cannot append to the trail
    // would take the entire write path down. Seeding through THIS role proves the INSERT grant and
    // gives the refusals below a row to aim at, in one step.
    const subjectId = 910_000_000 + Math.floor(Math.random() * 1_000_000);
    await seedRow(restrictedDb, subjectId);

    const seeded = await restrictedDb.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE subject_id = $1 LIMIT 1",
      [subjectId],
    );
    const rowId = seeded.rows[0]?.id;
    expect(rowId, "the runtime role must be able to append to, and read, the trail").toBeDefined();

    for (const [statement, values] of [
      ["UPDATE audit_log SET action = 'update' WHERE id = $1", [rowId]],
      ["DELETE FROM audit_log WHERE id = $1", [rowId]],
      ["TRUNCATE audit_log", []],
    ] as const) {
      const failure = await restrictedDb.query(statement, [...values]).then(
        () => undefined,
        (err: { code?: string }) => err,
      );
      expect(failure, `"${statement}" must be refused for the runtime role`).toBeDefined();
      // 42501, not 23001: the privilege check happens BEFORE the trigger, so this proves the
      // deploy-time REVOKE was applied rather than proving the trigger a second time.
      expect((failure as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    }
  });
});

test.describe("M3-4 source verification", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("a verification run fetches the entry's application page and records what it found", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `verify-${Date.now()}`, {
      applicationUrl: stack.urls.programme,
    });
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const reviewer = await api("reviewer");
    const run = await reviewer.post<{
      requestedUrl: string;
      httpStatus: number;
      existsAtSource: boolean;
      snapshotSha256: string;
      fieldDiff: Record<string, unknown>;
      matched: boolean;
    }>(`/v1/review/opportunities/${encodeURIComponent(id)}/verify`);

    expect(run.status).toBe(200);
    expect(run.body.requestedUrl, "the verifier fetches the entry's OWN application URL").toBe(
      stack.urls.programme,
    );
    expect(run.body.httpStatus).toBe(200);
    expect(run.body.existsAtSource).toBe(true);
    // A content digest is what makes "the page changed" answerable later without storing the page.
    expect(run.body.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.body.fieldDiff).toBeDefined();

    const entry = await publisher.get<{
      source: { verifiedAgainstSource?: boolean; verifiedAt?: string };
    }>(`/v1/me/opportunities/${encodeURIComponent(id)}`);
    expect(entry.body.source.verifiedAgainstSource).toBe(run.body.matched);
    expect(entry.body.source.verifiedAt ?? null).not.toBeNull();
  });

  test("a changed page yields a different digest", async ({ stack, api, opportunityFixture }) => {
    const publisher = await api("publisher");
    const reviewer = await api("reviewer");
    const stamp = Date.now();

    const first = opportunityFixture(stack.namespaces.publisher, `digest-a-${stamp}`, {
      applicationUrl: stack.urls.programme,
    });
    const second = opportunityFixture(stack.namespaces.publisher, `digest-b-${stamp}`, {
      // The same page, mutated. The fixture server serves a revised body for `?v=2`.
      applicationUrl: `${stack.urls.programme}?v=2`,
    });
    expect((await publisher.post("/v1/opportunities", first)).status).toBe(201);
    expect((await publisher.post("/v1/opportunities", second)).status).toBe(201);

    const runOne = await reviewer.post<{ snapshotSha256: string }>(
      `/v1/review/opportunities/${encodeURIComponent(first.id as string)}/verify`,
    );
    const runTwo = await reviewer.post<{ snapshotSha256: string }>(
      `/v1/review/opportunities/${encodeURIComponent(second.id as string)}/verify`,
    );
    expect(runOne.body.snapshotSha256).not.toBe(runTwo.body.snapshotSha256);
  });

  test("a missing page and a soft-not-found page are both reported as absent", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const reviewer = await api("reviewer");
    const stamp = Date.now();

    for (const [label, path] of [
      ["a real 404", "/missing"],
      // 200 with a "page not found" body. Trusting the status code alone would call this alive.
      ["a soft 404", "/soft-404"],
    ] as const) {
      const document = opportunityFixture(
        stack.namespaces.publisher,
        `absent-${label.replace(/\W+/g, "")}-${stamp}`,
        {
          applicationUrl: `${stack.urls.fixture}${path}`,
        },
      );
      expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

      const run = await reviewer.post<{ existsAtSource: boolean }>(
        `/v1/review/opportunities/${encodeURIComponent(document.id as string)}/verify`,
      );
      expect(run.status).toBe(200);
      expect(run.body.existsAtSource, `${label} must read as absent`).toBe(false);
    }
  });

  test("the verifier identifies itself and carries no ambient credential", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `identity-${Date.now()}`, {
      applicationUrl: stack.urls.programme,
    });
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);
    expect(
      (
        await (
          await api("reviewer")
        ).post(`/v1/review/opportunities/${encodeURIComponent(document.id as string)}/verify`)
      ).status,
    ).toBe(200);

    // The fixture server records every inbound request and exposes the log over HTTP, because it
    // runs in the RUNNER's process and this spec runs in a Playwright worker.
    const log = await fetch(`${stack.urls.fixture}/__requests`);
    const { requests } = (await log.json()) as {
      requests: Array<{
        path: string;
        headers: { userAgent?: string; cookie?: string; authorization?: string; referer?: string };
      }>;
    };

    const fetched = requests.filter((request) =>
      request.path.startsWith(`/programme/${stack.runId}`),
    );
    expect(fetched.length, "the verifier actually fetched the page").toBeGreaterThan(0);

    for (const request of fetched) {
      // A distinct agent is how an operator on the other end tells this traffic apart from a
      // person's browser, and how they can refuse it if they want to.
      expect(request.headers.userAgent, "the verifier names itself").toMatch(/rfphub-verifier/i);
      // None of these may ever travel outbound: they would carry the deployment's own session or
      // internal URLs to a third party the entry merely pointed at.
      expect(request.headers.cookie ?? null).toBeNull();
      expect(request.headers.authorization ?? null).toBeNull();
      expect(request.headers.referer ?? null).toBeNull();
    }
  });

  test("an entry with no application URL cannot be verified", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    // The fixture always carries an application URL, so it is rebuilt WITHOUT one rather than having
    // the key removed: an `applicationUrl: undefined` property still serialises away, but leaving the
    // key present would make the fixture's own shape the thing under test.
    const { applicationUrl: _omitted, ...document } = opportunityFixture(
      stack.namespaces.publisher,
      `nourl-${Date.now()}`,
    );
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const run = await (await api("reviewer")).post<{ error: string }>(
      `/v1/review/opportunities/${encodeURIComponent(document.id as string)}/verify`,
    );
    expect(run.status).toBe(400);
    expect(run.body.error).toBe("no_application_url");
  });

  test("the redirect limit and the size cap are enforced on bytes actually read", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const reviewer = await api("reviewer");
    const stamp = Date.now();

    const looping = opportunityFixture(stack.namespaces.publisher, `redirects-${stamp}`, {
      applicationUrl: `${stack.urls.fixture}/redirect-loop`,
    });
    expect((await publisher.post("/v1/opportunities", looping)).status).toBe(201);
    const loop = await reviewer.post<{ existsAtSource: boolean; error: string | null }>(
      `/v1/review/opportunities/${encodeURIComponent(looping.id as string)}/verify`,
    );
    expect(loop.status).toBe(200);
    expect(loop.body.existsAtSource, "a redirect chain past the limit is not a live page").toBe(
      false,
    );

    const oversized = opportunityFixture(stack.namespaces.publisher, `big-${stamp}`, {
      applicationUrl: `${stack.urls.fixture}/big`,
    });
    expect((await publisher.post("/v1/opportunities", oversized)).status).toBe(201);
    const big = await reviewer.post<{
      snapshotSha256: string | null;
      extracted: { truncated?: boolean } | null;
    }>(`/v1/review/opportunities/${encodeURIComponent(oversized.id as string)}/verify`, undefined, {
      timeoutMs: 60_000,
    });
    expect(big.status).toBe(200);

    // Completing at all is NOT the assertion — the fixture body is finite (8 MiB), so a reader that
    // ignored the cap entirely would also finish, and quickly. What has to be shown is that the
    // fetch stopped AT the cap.
    expect(big.body.extracted?.truncated, "the fetch must report that it was cut short").toBe(true);

    // And stopped at exactly the right byte. The digest is taken over the bytes actually read, and
    // this fixture streams one repeated character with no markup, so the expected digest can be
    // computed here independently: `VERIFY_MAX_BYTES` bytes of "a". If the reader stopped one chunk
    // late — the natural off-by-one when a 64 KiB chunk straddles the limit — this fails, which a
    // `truncated` flag on its own would not catch.
    const expectedDigest = createHash("sha256")
      .update(Buffer.alloc(VERIFY_MAX_BYTES, "a"))
      .digest("hex");
    expect(big.body.snapshotSha256, "the digest is over exactly the bytes the cap allowed").toBe(
      expectedDigest,
    );
  });

  test("a single publicly-redirecting hop is followed", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `redirect-ok-${Date.now()}`, {
      applicationUrl: `${stack.urls.fixture}/redirect-public`,
    });
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const run = await (await api("reviewer")).post<{ existsAtSource: boolean; finalUrl: string }>(
      `/v1/review/opportunities/${encodeURIComponent(document.id as string)}/verify`,
    );
    expect(run.status).toBe(200);
    expect(run.body.existsAtSource).toBe(true);
    expect(run.body.finalUrl, "the final URL is the destination, not the redirect").toContain(
      `/programme/${stack.runId}`,
    );
  });

  test("the verification job verifies a queued entry", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `jobverify-${Date.now()}`, {
      applicationUrl: stack.urls.programme,
    });
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    // The entry has never been checked. That is the precondition, and it is asserted rather than
    // assumed — if a submit-time verification had already run, everything below would be measuring
    // the wrong thing.
    const before = await db.query(
      `SELECT 1 FROM verification_runs v JOIN opportunities o ON o.id = v.opportunity_id
        WHERE o.public_id = $1`,
      [id],
    );
    expect(before.rowCount, "the fixture must start unverified").toBe(0);

    // THE JOB IS A BOUNDED-BATCH CURSOR JOB, so one invocation need not reach this particular row.
    // By the time this spec runs, a full suite has created dozens of entries that have never been
    // checked, and the batch limit is consumed by whichever the cursor reaches first — which is
    // correct behaviour, not a defect. So it is run until this entry is covered, and every run is
    // still required to do real work: a broken job that processed nothing would fail on the first
    // iteration rather than spinning.
    const admin = await api("admin");
    const verified = async (): Promise<number> => {
      const rows = await db.query(
        `SELECT 1 FROM verification_runs v JOIN opportunities o ON o.id = v.opportunity_id
          WHERE o.public_id = $1`,
        [id],
      );
      return rows.rowCount ?? 0;
    };

    let ranAtLeastOnce = false;
    for (let attempt = 0; attempt < 10 && (await verified()) === 0; attempt++) {
      const run = await admin.post<{ job: string; processed: number }>(
        "/v1/admin/jobs/verification-backfill/run",
        {},
      );
      expect(run.status).toBe(200);
      expect(run.body.job).toBe("verification-backfill");
      // `processed >= 0` is true of every number the job could possibly return, including the one a
      // disabled or broken job returns.
      expect(run.body.processed, "each run of the job must do real work").toBeGreaterThan(0);
      ranAtLeastOnce = true;
    }
    expect(ranAtLeastOnce, "the job must have been invoked").toBe(true);

    const after = await db.query<{ exists_at_source: boolean; http_status: number | null }>(
      `SELECT v.exists_at_source, v.http_status
         FROM verification_runs v JOIN opportunities o ON o.id = v.opportunity_id
        WHERE o.public_id = $1`,
      [id],
    );
    expect(after.rowCount, "the job must have verified this entry").toBe(1);
    expect(after.rows[0]?.http_status).toBe(200);
    expect(after.rows[0]?.exists_at_source).toBe(true);

    const entry = await publisher.get<{ source: { verifiedAt?: string | null } }>(
      `/v1/me/opportunities/${encodeURIComponent(id)}`,
    );
    expect(entry.body.source.verifiedAt ?? null, "and recorded it on the entry").not.toBeNull();
  });
});
