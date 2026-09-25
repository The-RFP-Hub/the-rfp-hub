ALTER TABLE "opportunities" ALTER COLUMN "spec_version" SET DEFAULT '1.0.1';--> statement-breakpoint
UPDATE "opportunities" SET "spec_version" = '1.0.1' WHERE "spec_version" = '1.0.0';
