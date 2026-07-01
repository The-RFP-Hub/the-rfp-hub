CREATE TYPE "public"."ingestion_method" AS ENUM('publisher_api', 'submission', 'scrape', 'import', 'outbox');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('upcoming', 'open', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."opportunity_type" AS ENUM('grant', 'hackathon', 'bounty', 'accelerator', 'vc_fund', 'rfp');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('foundation', 'dao', 'company', 'protocol', 'program', 'individual', 'other');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "dataset_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dataset_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"format" text NOT NULL,
	"entry_count" integer NOT NULL,
	"url" text NOT NULL,
	"ipfs_cid" text,
	"sha256" text,
	"spec_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opportunities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"spec_version" text DEFAULT '1.0.0' NOT NULL,
	"type" "opportunity_type" NOT NULL,
	"status" "opportunity_status" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"summary" text,
	"organization_id" bigint NOT NULL,
	"application_url" text,
	"website" text,
	"logo_url" text,
	"banner_url" text,
	"social_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ecosystems" text[] DEFAULT '{}' NOT NULL,
	"networks" text[] DEFAULT '{}' NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"currency" text,
	"min_award" numeric,
	"max_award" numeric,
	"total_budget" numeric,
	"amount_distributed" numeric,
	"awards_to_date" integer,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"type_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text NOT NULL,
	"source_publisher" text,
	"source_submitted_by" text,
	"source_submitted_at" timestamp with time zone,
	"ingested_via" "ingestion_method",
	"source_system" text,
	"original_id" text,
	"verified_against_source" boolean,
	"verified_at" timestamp with time zone,
	"snapshot_url" text,
	"review_status" "review_status" DEFAULT 'pending' NOT NULL,
	"is_listed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_publicId_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "org_type",
	"description" text,
	"website" text,
	"logo_url" text,
	"banner_url" text,
	"social_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ecosystems" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_opp_public_live" ON "opportunities" USING btree ("status","closes_at") WHERE "opportunities"."review_status" = 'approved' AND "opportunities"."is_listed";--> statement-breakpoint
CREATE INDEX "ix_opp_type" ON "opportunities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "ix_opp_org" ON "opportunities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ix_opp_closes_at" ON "opportunities" USING btree ("closes_at");--> statement-breakpoint
CREATE INDEX "ix_opp_budget" ON "opportunities" USING btree ("total_budget");--> statement-breakpoint
CREATE INDEX "ix_opp_award" ON "opportunities" USING btree ("min_award","max_award");--> statement-breakpoint
CREATE INDEX "ix_opp_updated" ON "opportunities" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gin_opp_ecosystems" ON "opportunities" USING gin ("ecosystems");--> statement-breakpoint
CREATE INDEX "gin_opp_networks" ON "opportunities" USING gin ("networks");--> statement-breakpoint
CREATE INDEX "gin_opp_categories" ON "opportunities" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "gin_opp_tags" ON "opportunities" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_opp_source" ON "opportunities" USING btree ("source_system","original_id");