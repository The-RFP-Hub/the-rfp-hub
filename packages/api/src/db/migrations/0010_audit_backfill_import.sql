-- CUSTOM migration (drizzle-kit generate --custom --name audit_backfill_import).
--
-- BACKFILL: give every opportunity whose appearance was never recorded the row its ingest should
-- have written.
--
-- The seed/import path upserted `opportunities` without appending to `audit_log` until the change
-- that ships alongside this migration. The milestone promises "an audit trail for any entry showing
-- all mutations", and `docs/data-model.md` states that every write is audited — so every row loaded
-- before that fix reads as an entry that appeared from nowhere. Fixing the code forward leaves the
-- existing corpus permanently unexplained, which is the half of the promise a reader actually hits.
--
-- ── Why `create` and not a new `import` action ──────────────────────────────────────────────────
-- `audit_action` is a closed vocabulary, enumerated in full in migration 0003 for the reason stated
-- there. Adding a value to it here is not merely against that convention, it does not WORK: the
-- Drizzle node-postgres migrator wraps every pending migration in ONE transaction, and PostgreSQL
-- refuses to use an enum value added by the transaction that is still adding it —
--
--     BEGIN;
--     ALTER TYPE audit_action ADD VALUE 'import';
--     SELECT 'import'::audit_action;
--     ERROR:  unsafe use of new value "import" of enum type audit_action
--
-- — except when the type itself was created in that same transaction. So it would pass on a fresh
-- database and fail on every deployment that is already migrated, which is the worst of the two
-- outcomes. The trail says the same thing without the enum: `create` by an `actor_kind='job'` with
-- `patch->>'job' = 'import'` naming the path and `patch->>'sourceSystem'` naming the origin. This
-- is the same shape the staleness job already uses for its own rows (`patch->>'job' = 'staleness'`).
--
-- ── Idempotent, and insert-only ─────────────────────────────────────────────────────────────────
-- The predicate is NO `create` ROW, not "no history at all". Those are different sets, and the
-- second one is wrong: an entry imported before this fix and then approved, edited, closed or
-- verified DOES have history — rows describing what happened to it afterwards — while still having
-- nothing that says where it came from. Scoping to "no history at all" would skip exactly the
-- entries active enough for somebody to go and read their trail, which is the whole audience.
--
-- `create` is the right marker because it is the one action nothing but a first write emits: the
-- submission path writes it on insert and never again, and no review, claim, merge, verification or
-- staleness path writes it at all. "No `create` row" therefore means "nobody ever recorded this
-- entry appearing", which is precisely the gap being filled — and it is also the idempotency, since
-- a second run sees the `create` rows the first one wrote and selects nothing.
--
-- Nothing here updates or deletes, so the append-only triggers from 0004 are never reached. That is
-- required, not incidental: `audit_log_no_update_delete` would abort this migration outright.
--
-- `created_at` is taken from the opportunity rather than defaulted to now(): the trail is ordered by
-- it, and stamping the whole corpus with the deploy time would put every entry's origin AFTER every
-- later decision made about it. `actor_role` stays NULL, which is what a job's row carries anyway.

INSERT INTO audit_log (
  subject_kind, subject_id, actor_kind, actor_account_id, actor_api_key_id, actor_role,
  action, patch, created_at
)
SELECT
  'opportunity',
  o.id,
  'job',
  NULL,
  NULL,
  NULL,
  'create',
  jsonb_build_object('backfill', true, 'job', 'import', 'sourceSystem', o.source_system),
  o.created_at
FROM opportunities o
WHERE NOT EXISTS (
  SELECT 1 FROM audit_log a
  WHERE a.subject_kind = 'opportunity' AND a.subject_id = o.id AND a.action = 'create'
);
