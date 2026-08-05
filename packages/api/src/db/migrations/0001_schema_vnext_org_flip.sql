-- Schema v-next re-cut (v1.0.0 re-cut in place): operatingOrganizations becomes THE primary,
-- required org array; sponsoringOrganizations becomes optional; networks/tags/extensions are
-- removed from the Standard; eligibility becomes free text; resourceLinks → additionalReferences;
-- organizations.type → org_type; the denormalized filter key sponsor_slugs → org_slugs (now the
-- UNION of operating + sponsoring slugs); socialLinks becomes an array of {platform, url}.
--
-- FORWARD-ONLY (like 0000). Reversal-in-spirit notes per step:
--   * dropped columns/indexes (networks, tags, extensions + their GINs) would be re-created from
--     the 0000 DDL; their data is an accepted loss under the new Standard;
--   * renames (resource_links, sponsor_slugs + its GIN, organizations.type) reverse by renaming back;
--   * eligibility text cannot be restored to the old jsonb key→value map (lossy by design);
--   * the org-array nullability/default flip reverses by swapping the SET/DROP DEFAULT pair.
--
-- DATA NOTE: rows written before this migration store pre-re-cut jsonb payloads (deadlines[].type
-- instead of deadlineType, organization.type instead of orgType, possibly missing slugs, socialLinks
-- as a {platform: url} map). Those payloads are NOT rewritten here — the M2 corpus is re-seeded
-- from source after migrating (scripts/seed.ts), which recomputes next_deadline_at and org_slugs.
DROP INDEX "gin_opp_networks";--> statement-breakpoint
DROP INDEX "gin_opp_tags";--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "networks";--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "tags";--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "extensions";--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "eligibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "eligibility" DROP NOT NULL;--> statement-breakpoint
-- old values are jsonb objects; '{}' (never meaningful) becomes NULL, anything else its JSON text
ALTER TABLE "opportunities" ALTER COLUMN "eligibility" SET DATA TYPE text USING nullif("eligibility"::text, '{}');--> statement-breakpoint
ALTER TABLE "opportunities" RENAME COLUMN "resource_links" TO "additional_references";--> statement-breakpoint
-- org-array flip: operating is required (no default — every insert must supply it), sponsoring optional
ALTER TABLE "opportunities" ALTER COLUMN "operating_organizations" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "sponsoring_organizations" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" RENAME COLUMN "sponsor_slugs" TO "org_slugs";--> statement-breakpoint
ALTER INDEX "gin_opp_sponsors" RENAME TO "gin_opp_org_slugs";--> statement-breakpoint
-- socialLinks is now an ARRAY of {platform, url} entries (default flips '{}' → '[]')
ALTER TABLE "opportunities" ALTER COLUMN "social_links" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "social_links" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "organizations" RENAME COLUMN "type" TO "org_type";
