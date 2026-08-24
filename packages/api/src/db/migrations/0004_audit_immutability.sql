-- CUSTOM migration (drizzle-kit generate --custom --name audit_immutability).
--
-- APPEND-ONLY, ENFORCED BY THE DATABASE.
--
-- `audit_log` is the record of who changed what. "Append-only" asserted by a test proves one code
-- path; asserted by a `REVOKE` proves whatever a particular deployment happened to run. A trigger
-- proves it everywhere the schema exists — a developer's laptop, a throwaway test database, CI,
-- staging, production — and it proves it for statements nobody wrote a code path for.
--
-- The `REVOKE UPDATE, DELETE` in packages/api/scripts/sql/harden-audit.sql is defence in depth on
-- top of this, and is deliberately NOT a migration: it names a deployment-specific role, and a
-- migration hard-coding one would fail on every deployment that named its role something else.
--
-- Note what is NOT protected here: `TRUNCATE` fires a statement-level trigger, not a row-level
-- one, so it is covered by its own trigger below rather than by the same one. And nothing here can
-- stop the table's OWNER from dropping the trigger — that is what the split migration/runtime
-- credentials in docs/deploy.md are for.

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a mistaken entry by INSERTing a further row that records the correction. History is not edited.';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
--> statement-breakpoint

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
