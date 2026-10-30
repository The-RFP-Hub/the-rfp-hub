-- better-auth 1.7.3+ identifies an account by (provider_id, account_id) again and never writes
-- `issuer` (the 1.7.0–1.7.2 key). With `issuer NOT NULL` every account insert would fail, and the
-- adapter's init-time schema check refuses to serve auth at all. Per the library's 1.7 upgrade
-- guide ("Account identity keeps the provider key"): relax the column — NOT dropped, so a rollback
-- to a 1.7.1 build (which still writes it) keeps working — and move the unique key to the columns
-- the runtime looks accounts up by. The new index cannot conflict with existing rows: `issuer` was
-- derived from `provider_id` one-to-one, so (issuer, account_id) unique already implied it.
-- See src/db/auth-schema.ts.
DROP INDEX "ux_auth_account_issuer_account";--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_auth_account_provider_account" ON "auth_account" USING btree ("provider_id","account_id");