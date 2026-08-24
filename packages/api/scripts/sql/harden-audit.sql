-- Defense in depth for the append-only audit trail. NOT a migration, and not the mechanism.
--
-- The mechanism is the `audit_log_append_only` trigger shipped in src/db/migrations: it raises an
-- exception on any UPDATE or DELETE, in every environment, including a developer's laptop and a
-- throwaway test database. That property must not depend on a deployment having run this file.
--
-- What this file adds is the layer below: a runtime role that has not been GRANTed the ability to
-- issue the statement in the first place, so the attempt fails at permission-checking time rather
-- than in a trigger the same role could, with enough privilege, disable. It is not a migration
-- because it names a role, and role names are a property of a deployment rather than of the schema
-- — a migration hard-coding one would fail on every deployment that named its role something else.
--
-- Run it once per deployment, as an ADMIN/owner connection, after the migrations:
--
--   psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/harden-audit.sql
--
-- `:role` is the SERVICE's role — the one in the task definition's DATABASE_URL — never the
-- migration role, which needs DDL and therefore owns the table.

\set ON_ERROR_STOP on

-- The service inserts audit rows and reads them back. It never rewrites history.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM :"role";
GRANT  SELECT, INSERT                ON TABLE audit_log TO   :"role";

-- Default privileges cover the table that exists today. A future migration creating a new history
-- table under the migration role would grant nothing to the service by default, which is the right
-- direction to fail in — add the grant deliberately rather than widening this to ALL TABLES.

-- What the service is left holding, for the record it prints back to you.
SELECT privilege_type
FROM   information_schema.table_privileges
WHERE  table_name = 'audit_log' AND grantee = :'role'
ORDER  BY privilege_type;
