ALTER TABLE "opportunities" ADD COLUMN "reviewed_application_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "reviewed_website" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_requested_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_final_url" text;--> statement-breakpoint
-- BACKFILL THE LANDING BASELINE (hand-written): for each row, the last source check of its CURRENT
-- apply URL that was applied AND got an answer from a server. A run's `error` is NULL exactly when
-- the fetch returned a response and its verdict was applied — a stale result, a transient failure
-- and a refused fetch each record why in `error` — so that is the filter. This is the baseline the
-- next check compares with (`verification.service.ts`); comparing against the run log instead
-- would let a discarded or pruned run stand in for it. A row with no such run keeps NULL, and its
-- first answered check after deploy becomes the baseline without being compared with anything.
-- `btrim` because the check requests the trimmed URL.
UPDATE "opportunities" AS o
SET "link_landing_requested_url" = r."requested_url",
    "link_landing_final_url" = r."final_url"
FROM (
  SELECT DISTINCT ON ("opportunity_id") "opportunity_id", "requested_url", "final_url"
  FROM "verification_runs"
  WHERE "error" IS NULL AND "http_status" IS NOT NULL AND "final_url" IS NOT NULL
  ORDER BY "opportunity_id", "run_at" DESC, "id" DESC
) AS r
WHERE r."opportunity_id" = o."id"
  AND r."requested_url" = btrim(o."application_url");
--> statement-breakpoint
-- BACKFILL (hand-written below the generated DDL): every approved row's CURRENT links count as the
-- reviewed ones.
--
-- `/v1/r/:id/{apply,source}` now hops straight through only when the stored URL equals the one a
-- person last approved, and sends the reader to the frontend's leaving page otherwise. Without this
-- statement every row starts NULL — unreviewed — and the whole corpus would switch to the leaving
-- page on deploy day. Pinning what is approved today keeps the change to the one set of listings
-- the new rule is meant to catch on its first day: closed and archived ones, whose reason is
-- decided by `status` and needs no pin. Every later difference comes from a write after this one.
--
-- What it does NOT claim: an approved row's link may have been set by a verified publisher's
-- auto-approved write that no reviewer saw. That trust was already extended before this column
-- existed, and withdrawing it retroactively would be the corpus-wide extra click above; from here
-- on, such a write leaves the pin where it was. Pending and rejected rows stay NULL — they are not
-- public, and their approval will pin them. Idempotent: it writes values derived from the row.
UPDATE "opportunities"
SET "reviewed_application_url" = "application_url",
    "reviewed_website" = "website"
WHERE "review_status" = 'approved';
