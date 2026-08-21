/**
 * Least privilege on `audit_log`, proved at TWO independent layers, against TWO different
 * connections — the gap `audit.test.ts` leaves by only ever connecting as the migration/owner
 * role and only ever asserting a message substring.
 *
 * Layer 1 — the RUNTIME ROLE (`scripts/sql/harden-audit.sql`, read before writing this file so the
 * assertions match exactly what it grants and revokes): `REVOKE UPDATE, DELETE, TRUNCATE` and
 * `GRANT SELECT, INSERT` on `audit_log`, to the deployment's service role. A statement the role has
 * not been granted fails at permission-checking time, SQLSTATE `42501` (`insufficient_privilege`)
 * — before Postgres even reaches the trigger.
 *
 * Layer 2 — the AUDIT_LOG_IS_APPEND_ONLY TRIGGER (migration `0004_audit_immutability.sql`), which
 * fires for the OWNER/migration role too, since the trigger — not a grant — is what makes
 * "append-only" true regardless of who is connected. Its function raises with an EXPLICIT
 * `USING ERRCODE = 'restrict_violation'`, which is SQLSTATE `23001` — NOT the `P0001` a bare
 * `RAISE EXCEPTION` would default to. This was verified empirically against this migration before
 * writing the assertions below (`psql`, `\set VERBOSITY sqlstate`): TRUNCATE fires the
 * statement-level trigger unconditionally; UPDATE/DELETE fire the row-level trigger only when a
 * row is actually matched, so both are exercised against a row seeded for the purpose.
 *
 * ── Running this file locally ──────────────────────────────────────────────────────────────────
 * It is gated on the optional `RESTRICTED_DATABASE_URL` and skips cleanly (with the same style of
 * loud warning as `db-gate.ts`) when unset — CI is unaffected. To exercise it against the throwaway
 * Postgres (`packages/api/docker-compose.test.yml`, port 5439), as an ADMIN/owner connection:
 *
 *   ROLE=rfphub_runtime_scratch_<random>
 *   docker compose -f docker-compose.test.yml exec -T postgres psql -U rfphub -d rfphub -c "
 *     CREATE ROLE ${ROLE} LOGIN PASSWORD '<password>';
 *     GRANT CONNECT ON DATABASE rfphub TO ${ROLE};
 *     GRANT USAGE ON SCHEMA public TO ${ROLE};
 *     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
 *     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};"
 *   docker compose -f docker-compose.test.yml exec -T postgres \
 *     psql -U rfphub -d rfphub -v role=${ROLE} -f scripts/sql/harden-audit.sql
 *   RESTRICTED_DATABASE_URL=postgres://${ROLE}:<password>@127.0.0.1:5439/rfphub \
 *   DATABASE_URL=postgres://rfphub:rfphub@127.0.0.1:5439/rfphub \
 *     npx vitest run test/integration/audit-privilege.test.ts
 *   # afterwards, as the admin connection: DROP ROLE ${ROLE};
 *
 * Isolation: this file writes only `audit_log` rows tagged with negative, run-local `subject_id`
 * values. Those rows are never deleted (nothing can delete an `audit_log` row — that is the
 * property under test) but carry no foreign key and resolve to nothing.
 */
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/client.js";

const hasAdmin = Boolean(process.env.DATABASE_URL);
const hasRestricted = Boolean(process.env.RESTRICTED_DATABASE_URL);

const FLAG = "__rfphubAuditPrivilegeSkipWarned";
const flags = globalThis as typeof globalThis & { [FLAG]?: boolean };

if (!(hasAdmin && hasRestricted) && !flags[FLAG]) {
  flags[FLAG] = true;
  console.warn(
    [
      "RESTRICTED_DATABASE_URL is not set — SKIPPING the least-privilege audit_log tests (every",
      "other integration test is unaffected).",
      "See the comment at the top of test/integration/audit-privilege.test.ts for how to create a",
      "scratch runtime role against the throwaway Postgres and run this file against it.",
    ].join("\n"),
  );
}

const run: typeof describe =
  hasAdmin && hasRestricted ? describe : (describe.skip as typeof describe);

// Negative so they can never collide with a real, identity-generated `audit_log.id`-adjacent
// `subject_id`, and distinct per role so each case's row-level trigger fires against a row that
// only that case touched.
const RESTRICTED_SUBJECT_ID = -900001;
const OWNER_SUBJECT_ID = -900002;

async function seedRow(client: pg.Pool, subjectId: number): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (subject_kind, subject_id, actor_kind, action) VALUES ('account', $1, 'job', 'create')`,
    [subjectId],
  );
}

run("M3AUDITPRIV least privilege on audit_log, both layers, both connections", () => {
  let restricted: pg.Pool;

  afterAll(async () => {
    await restricted?.end();
  });

  it("the restricted runtime role: SELECT and INSERT succeed; UPDATE, DELETE, TRUNCATE fail 42501", async () => {
    restricted = new pg.Pool({ connectionString: process.env.RESTRICTED_DATABASE_URL });

    await seedRow(restricted, RESTRICTED_SUBJECT_ID);

    // `audit_log` rows are never deletable (that is the property under test), so a rerun against
    // the same database accumulates more than one row under this subject_id — assert presence,
    // not an exact count.
    const selected = await restricted.query("SELECT id FROM audit_log WHERE subject_id = $1", [
      RESTRICTED_SUBJECT_ID,
    ]);
    expect(selected.rowCount ?? 0).toBeGreaterThanOrEqual(1);

    await expect(
      restricted.query("UPDATE audit_log SET action = 'update' WHERE subject_id = $1", [
        RESTRICTED_SUBJECT_ID,
      ]),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      restricted.query("DELETE FROM audit_log WHERE subject_id = $1", [RESTRICTED_SUBJECT_ID]),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(restricted.query("TRUNCATE audit_log")).rejects.toMatchObject({ code: "42501" });
  });

  it("the migration/owner role: UPDATE, DELETE, TRUNCATE fail 23001 from the immutability trigger", async () => {
    await seedRow(pool, OWNER_SUBJECT_ID);

    await expect(
      pool.query("UPDATE audit_log SET action = 'update' WHERE subject_id = $1", [
        OWNER_SUBJECT_ID,
      ]),
    ).rejects.toMatchObject({ code: "23001" });

    await expect(
      pool.query("DELETE FROM audit_log WHERE subject_id = $1", [OWNER_SUBJECT_ID]),
    ).rejects.toMatchObject({ code: "23001" });

    await expect(pool.query("TRUNCATE audit_log")).rejects.toMatchObject({ code: "23001" });
  });
});
