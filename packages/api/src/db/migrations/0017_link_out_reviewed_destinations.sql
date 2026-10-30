ALTER TABLE "opportunities" ADD COLUMN "reviewed_application_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "reviewed_website" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_changed_at" timestamp with time zone;--> statement-breakpoint
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
