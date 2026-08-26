ALTER TYPE "public"."audit_action" ADD VALUE 'invite_member' BEFORE 'verify_organization';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'accept_member_invite' BEFORE 'verify_organization';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'revoke_member_invite' BEFORE 'verify_organization';--> statement-breakpoint
CREATE TABLE "org_membership_invites" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "org_membership_invites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" bigint NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" DEFAULT 'publisher' NOT NULL,
	"invited_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_account_id" bigint
);
--> statement-breakpoint
ALTER TABLE "org_membership_invites" ADD CONSTRAINT "org_membership_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_invites" ADD CONSTRAINT "org_membership_invites_invited_by_accounts_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_invites" ADD CONSTRAINT "org_membership_invites_accepted_account_id_accounts_id_fk" FOREIGN KEY ("accepted_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_org_membership_invite_pending" ON "org_membership_invites" USING btree ("organization_id",lower("email")) WHERE "org_membership_invites"."accepted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_org_membership_invite_pending_email" ON "org_membership_invites" USING btree (lower("email")) WHERE "org_membership_invites"."accepted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_org_membership_invite_organization" ON "org_membership_invites" USING btree ("organization_id","created_at");