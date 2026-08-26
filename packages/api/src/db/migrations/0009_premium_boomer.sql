CREATE TYPE "public"."notification_kind" AS ENUM('duplicate_suspected', 'duplicate_confirmed', 'duplicate_dismissed', 'duplicate_merged_away', 'duplicate_absorbed', 'duplicate_reopened');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"email_dispatched_at" timestamp with time zone,
	"email_failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_notification_event" ON "notifications" USING btree ("account_id","kind","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "ix_notification_account_created" ON "notifications" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_notification_account_unread" ON "notifications" USING btree ("account_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" is null;