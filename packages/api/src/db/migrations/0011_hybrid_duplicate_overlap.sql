ALTER TABLE "opportunity_duplicates" ADD COLUMN "signal" jsonb;--> statement-breakpoint
ALTER TABLE "opportunity_duplicates" ADD COLUMN "rules_version" smallint;--> statement-breakpoint
ALTER TABLE "opportunity_embeddings" ADD COLUMN "norm" double precision;--> statement-breakpoint
ALTER TABLE "opportunity_embeddings" ADD COLUMN "token_count" integer;