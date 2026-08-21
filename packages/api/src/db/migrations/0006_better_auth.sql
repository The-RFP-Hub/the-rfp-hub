-- Better-Auth adoption: the four `auth_*` tables, plus the `accounts` join-key swap
-- (`privy_did`/`primary_wallet`/`email`/`enriched_at` → `auth_user_id`).
--
-- GENERATED IN TWO PASSES, SQUASHED INTO ONE FILE. `drizzle-kit generate` prompts interactively
-- ("was accounts.email renamed to X?") when a single diff both drops and adds columns on the same
-- table, because it cannot tell a rename from an unrelated drop+add. There is no non-interactive
-- flag for that prompt. So this file's DDL was produced as two separate `db:generate` runs — one
-- that only ADDED `auth_user_id` and the four `auth_*` tables, one that only DROPPED the four old
-- `accounts` columns — each unambiguous on its own, then concatenated here in dependency order
-- (create the referenced tables and the new column before anything that could rely on them; drop
-- the old columns last). `meta/0006_snapshot.json` is the final-state snapshot from the second
-- pass (its `prevId` retargeted to point at `meta/0005_snapshot.json` directly, skipping the
-- discarded intermediate) — it is a complete schema snapshot, not a diff, so this is equivalent to
-- what a single unprompted `generate` would have produced.
--
-- THE DROP IS NOT A RENAME. `privy_did` had no successor: Privy never reached production, so there
-- is no user-facing migration to perform, and a renamed-but-orphaned column would be a stale key
-- matching nothing (see the DATA section below for what that implies for existing rows).

CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_auth_account_issuer_account" ON "auth_account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "ix_auth_account_user" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_session_user" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_verification_identifier" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_authUserId_unique" UNIQUE("auth_user_id");--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_privyDid_unique";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "privy_did";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "primary_wallet";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "enriched_at";
--> statement-breakpoint

-- ── DATA: neutralize every pre-existing account, which is now unreachable ──────────────────────
--
-- Every row in `accounts` just lost its join key: `auth_user_id` is NULL for all of them (nobody
-- has signed in through Better-Auth yet — the column was only just added, above). No user-facing
-- migration exists for these rows: Privy never reached production (see the header), and the
-- Better-Auth owner decisions record that no staging identity is worth preserving.
--
-- An orphaned row is not merely inert; left alone it is two separate footguns:
--
--   1. An orphaned ADMIN still satisfies `admin.service.ts`'s "at least one admin exists" guard,
--      so the system believes it has a working administrator that can no longer sign in — a
--      lockout that looks, from the guard's point of view, like a healthy fleet. Demoting every
--      orphan to `submitter` forces the guard to see the truth: admin access must be re-granted by
--      ceremony after the affected person signs in again under their new `auth_user` identity, per
--      the migration's rollout runbook.
--   2. An orphaned account's API keys are still LIVE CREDENTIALS — `key_hash` verification does
--      not consult `auth_user_id` at all, so a bearer of one of these keys keeps working access to
--      an account whose owner can no longer be authenticated as. Revoking them (soft: `revoked_at`,
--      matching the table's existing revocation model — see schema.ts) closes that gap the same
--      way any other key revocation does.
--
-- Both are scoped to `auth_user_id IS NULL` — i.e. rows this migration itself just orphaned, not
-- any row a later, unrelated write might leave in that state.

--   3. `direct_create` is the third privilege on the row, and it is independent of the role: it
--      publishes into ANY namespace without a membership. It is dropped for the same reason as the
--      role — a privilege on an identity nobody can authenticate as is a privilege waiting for a
--      row to be re-attached to a live identity by hand.
--
-- The WHERE clause narrows to rows that actually carry something, so `updated_at` is not churned
-- across the whole table on a migration that changed nothing about most of it.

UPDATE "accounts"
SET    "global_role" = 'submitter', "direct_create" = false, "updated_at" = now()
WHERE  "auth_user_id" IS NULL
  AND  ("global_role" <> 'submitter' OR "direct_create");
--> statement-breakpoint
UPDATE "api_keys" SET "revoked_at" = now()
WHERE "revoked_at" IS NULL
  AND "account_id" IN (SELECT "id" FROM "accounts" WHERE "auth_user_id" IS NULL);
