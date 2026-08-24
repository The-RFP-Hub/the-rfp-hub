-- Runtime privileges on the four `auth_*` tables. NOT a migration, for the same reason
-- harden-audit.sql is not one: a GRANT names a ROLE, and role names are a property of a deployment
-- rather than of the schema. A migration hard-coding one would fail on every deployment that named
-- its role something else.
--
-- WHY THIS FILE HAS TO EXIST AT ALL. The migrations run as the MIGRATION role, which owns the
-- tables it creates. The service runs as a different, restricted role, and a table it does not own
-- grants it nothing by default. So without this file every login fails at permission-checking time
-- — `SELECT` on `auth_session` refused — while the schema is perfectly correct and every test that
-- runs against an owner connection passes. That is the single most likely production-only failure
-- of the Better-Auth adoption, which is why it is a deploy artifact with its own runbook step
-- rather than a footnote.
--
-- Run it once per deployment, as an ADMIN/owner connection, AFTER the migrations:
--
--   psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/grant-auth.sql
--
-- `:role` is the SERVICE's role — the one in the task definition's DATABASE_URL — never the
-- migration role, which needs DDL and therefore owns the tables.
--
-- FOUR EXPLICIT GRANTS, NOT `ALTER DEFAULT PRIVILEGES`. Default privileges would silently grant on
-- every table a future migration creates, which is precisely the failure mode harden-audit.sql
-- argues against in its own closing comment: a new table should grant nothing until somebody
-- decides it should. The cost is that adding a fifth auth table means editing this file — and that
-- edit is the point.
--
-- NO SEQUENCE GRANTS. Better-Auth's ids are CSPRNG strings minted in JS (`id text PRIMARY KEY`,
-- see src/db/auth-schema.ts), so these tables own no sequence for a role to need USAGE on. If a
-- future version introduces one, this comment is the thing that should stop being true.

\set ON_ERROR_STOP on

-- The service reads and writes all four: it creates users and sessions on sign-in, updates the
-- session row on the rolling refresh (`updateAge`), deletes it on sign-out, links provider accounts,
-- and consumes single-use verification rows. DELETE is not optional — without it a sign-out cannot
-- remove the session, which is the whole revocation property.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_user         TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_session      TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_account      TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_verification TO :"role";

-- What the service is left holding, for the record it prints back to you. Four rows per table is
-- the expected shape; anything short of it is a deployment that will fail to log anybody in.
SELECT table_name, privilege_type
FROM   information_schema.table_privileges
WHERE  table_name IN ('auth_user', 'auth_session', 'auth_account', 'auth_verification')
  AND  grantee = :'role'
ORDER  BY table_name, privilege_type;
