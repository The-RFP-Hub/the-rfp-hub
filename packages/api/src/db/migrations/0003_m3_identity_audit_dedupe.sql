CREATE TYPE "public"."account_role" AS ENUM('submitter', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('user', 'api_key', 'job', 'outbox');--> statement-breakpoint
CREATE TYPE "public"."analytics_event" AS ENUM('list_view', 'detail_view', 'source_click', 'apply_click');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'approve', 'reject', 'unlist', 'relist', 'close', 'reopen', 'verify_source', 'merge', 'confirm_duplicate', 'dismiss_duplicate', 'claim', 'grant_publisher', 'revoke_publisher', 'verify_organization', 'unverify_organization', 'update_organization', 'assign_role', 'grant_direct_create', 'revoke_direct_create', 'create_api_key', 'revoke_api_key');--> statement-breakpoint
CREATE TYPE "public"."audit_subject_kind" AS ENUM('opportunity', 'organization', 'account', 'api_key', 'claim', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."dup_status" AS ENUM('suspected', 'confirmed', 'dismissed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'publisher');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"privy_did" text,
	"primary_wallet" text,
	"email" text,
	"display_name" text,
	"handle" text,
	"global_role" "account_role" DEFAULT 'submitter' NOT NULL,
	"direct_create" boolean DEFAULT false NOT NULL,
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_privyDid_unique" UNIQUE("privy_did"),
	CONSTRAINT "accounts_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"name" text,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{read}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_kind" "audit_subject_kind" NOT NULL,
	"subject_id" bigint NOT NULL,
	"actor_account_id" bigint,
	"actor_api_key_id" bigint,
	"actor_kind" "actor_kind" NOT NULL,
	"action" "audit_action" NOT NULL,
	"patch" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opportunity_claims_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"opportunity_id" bigint NOT NULL,
	"organization_id" bigint NOT NULL,
	"account_id" bigint,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_duplicates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opportunity_duplicates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"opportunity_id" bigint NOT NULL,
	"duplicate_of_id" bigint NOT NULL,
	"similarity" numeric,
	"status" "dup_status" DEFAULT 'suspected' NOT NULL,
	"reviewed_by" bigint,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "ck_dup_not_self" CHECK ("opportunity_duplicates"."opportunity_id" <> "opportunity_duplicates"."duplicate_of_id")
);
--> statement-breakpoint
CREATE TABLE "opportunity_embeddings" (
	"opportunity_id" bigint PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"provider_id" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opportunity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"opportunity_id" bigint NOT NULL,
	"event_type" "analytics_event" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_hash" text,
	"ip_hash" text,
	"referrer" text
);
--> statement-breakpoint
CREATE TABLE "opportunity_stats_daily" (
	"opportunity_id" bigint NOT NULL,
	"day" date NOT NULL,
	"list_views" integer DEFAULT 0 NOT NULL,
	"detail_views" integer DEFAULT 0 NOT NULL,
	"source_clicks" integer DEFAULT 0 NOT NULL,
	"apply_clicks" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_stats_daily_opportunity_id_day_pk" PRIMARY KEY("opportunity_id","day")
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "org_memberships_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"organization_id" bigint NOT NULL,
	"role" "org_role" DEFAULT 'publisher' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"opportunity_id" bigint NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_url" text,
	"final_url" text,
	"http_status" integer,
	"exists_at_source" boolean,
	"extracted" jsonb,
	"field_diff" jsonb,
	"matched" boolean,
	"snapshot_text" text,
	"snapshot_sha256" text,
	"snapshot_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "submitted_by" bigint;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "approved_by" bigint;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "merged_into_id" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_claims" ADD CONSTRAINT "opportunity_claims_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_claims" ADD CONSTRAINT "opportunity_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_claims" ADD CONSTRAINT "opportunity_claims_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_claims" ADD CONSTRAINT "opportunity_claims_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" ADD CONSTRAINT "opportunity_duplicates_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" ADD CONSTRAINT "opportunity_duplicates_duplicate_of_id_opportunities_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" ADD CONSTRAINT "opportunity_duplicates_reviewed_by_accounts_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_embeddings" ADD CONSTRAINT "opportunity_embeddings_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_stats_daily" ADD CONSTRAINT "opportunity_stats_daily_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "ix_api_keys_account" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_audit_subject" ON "audit_log" USING btree ("subject_kind","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_audit_actor" ON "audit_log" USING btree ("actor_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_claim_pending" ON "opportunity_claims" USING btree ("opportunity_id","organization_id") WHERE "opportunity_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ix_claim_status" ON "opportunity_claims" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_dup_pair" ON "opportunity_duplicates" USING btree (least("opportunity_id", "duplicate_of_id"),greatest("opportunity_id", "duplicate_of_id"));--> statement-breakpoint
CREATE INDEX "ix_dup_status" ON "opportunity_duplicates" USING btree ("status","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_dup_of" ON "opportunity_duplicates" USING btree ("duplicate_of_id");--> statement-breakpoint
CREATE INDEX "ix_opp_embed" ON "opportunity_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ix_event_opp_day" ON "opportunity_events" USING btree ("opportunity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_event_occurred" ON "opportunity_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_org_membership" ON "org_memberships" USING btree ("account_id","organization_id");--> statement-breakpoint
CREATE INDEX "ix_org_membership_account" ON "org_memberships" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_verification_opp" ON "verification_runs" USING btree ("opportunity_id","run_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_submitted_by_accounts_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_approved_by_accounts_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_merged_into_id_opportunities_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_opp_last_seen" ON "opportunities" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ix_opp_submitted_by" ON "opportunities" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "ix_opp_source_publisher" ON "opportunities" USING btree ("source_publisher");