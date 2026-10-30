ALTER TABLE "opportunities" ADD COLUMN "reviewed_application_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "reviewed_website" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_requested_url" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "link_landing_final_url" text;--> statement-breakpoint
-- BACKFILL THE LANDING BASELINE (hand-written): for each row, its latest source check that the
-- verifier would itself have kept as the baseline — an APPLIED run that got an ANSWER from a server
-- (`verification.service.ts`: `applied && http_status IS NOT NULL && final_url IS NOT NULL`). That
-- includes answered refusals (a content type it would not read, a redirect it stopped following),
-- which carry an `error` but did land somewhere; so the filter is not `error IS NULL`. It excludes
-- the runs that were not verdicts, by the markers the verifier has written into `error` since they
-- existed (`stale_result:` since 2026-08-24, `not_a_verdict:` since 2026-08-26, unchanged since); a
-- transient run never has an HTTP status in any case. Comparing against the run log at runtime
-- instead would let exactly those runs stand in for the baseline, which is what this column fixes.
-- No URL filter: the verifier compares only when the baseline's requested URL equals the URL it is
-- about to request (the trimmed `application_url`), so a baseline for an older URL is simply not
-- compared and gets replaced — and matching here would need JavaScript's `trim()` in SQL.
-- A row with no such run keeps NULL, and its first answered check becomes the baseline.
UPDATE "opportunities" AS o
SET "link_landing_requested_url" = r."requested_url",
    "link_landing_final_url" = r."final_url"
FROM (
  SELECT DISTINCT ON ("opportunity_id") "opportunity_id", "requested_url", "final_url"
  FROM "verification_runs"
  WHERE "http_status" IS NOT NULL
    AND "final_url" IS NOT NULL
    AND "requested_url" IS NOT NULL
    AND position('stale_result:' in coalesce("error", '')) = 0
    AND position('not_a_verdict:' in coalesce("error", '')) = 0
  ORDER BY "opportunity_id", "run_at" DESC, "id" DESC
) AS r
WHERE r."opportunity_id" = o."id";
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
