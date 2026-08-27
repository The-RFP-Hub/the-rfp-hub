-- RE-RUNNABLE BY HAND, and that is a repair rather than a style preference.
--
-- This file was regenerated IN PLACE after an earlier version of it — the one that added
-- `rules_version smallint` instead of `rules_key text` — had already been applied to a running
-- database, and the regeneration moved the journal's `when` for this entry. Drizzle decides what
-- to apply by comparing `created_at` in `drizzle.__drizzle_migrations` with that `when`, so a
-- database carrying the OLD 0011 is offered the NEW one, and the generated form aborted on
-- `ADD COLUMN "signal"` because that column was already there. The migration runs in a
-- transaction, so the whole thing rolled back: `rules_key` was never added, every later
-- `pnpm migrate` failed on the same statement, and the API — which selects the column — answered
-- 500 on every duplicate read.
--
-- `IF NOT EXISTS` on each add makes the two states converge: a database that never saw 0011 gets
-- all four columns, and one that saw the old one gets only what it is missing. The `DROP COLUMN
-- IF EXISTS rules_version` retires the column the superseded version added; it is dropped rather
-- than renamed because the values under it were a hand-maintained integer that the derived key
-- gives no meaning to, and a pair whose stamp is NULL is exactly what the resweep arm selects and
-- re-judges.
ALTER TABLE "opportunity_duplicates" ADD COLUMN IF NOT EXISTS "signal" jsonb;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" ADD COLUMN IF NOT EXISTS "rules_key" text;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" DROP COLUMN IF EXISTS "rules_version";--> statement-breakpoint
ALTER TABLE "opportunity_embeddings" ADD COLUMN IF NOT EXISTS "norm" double precision;--> statement-breakpoint
ALTER TABLE "opportunity_embeddings" ADD COLUMN IF NOT EXISTS "token_count" integer;
