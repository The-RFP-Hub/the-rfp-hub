/**
 * RFP Hub `/v1/` API — Drizzle schema (M2 subset).
 *
 * This is the IMPLEMENTED slice of the full design in `packages/api/docs/data-model.md`.
 * The data-model doc remains the canonical design target; M2 intentionally implements only the
 * read layer (`organizations`, `opportunities`, `dataset_snapshots`). Everything heavy — pgvector
 * embeddings, partitioned analytics, audit/verification/dup tables, auth (`accounts`/`api_keys`/
 * `org_memberships`), the outbox, the generated `tsvector` column and `type_data` GIN — is
 * DEFERRED to M3/M4 and is documented (with status tags) in data-model.md.
 *
 * Column names are written camelCase here and mapped to snake_case in SQL via Drizzle
 * `casing: "snake_case"` (configured in drizzle.config.ts and the runtime client).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────────────
export const opportunityType = pgEnum("opportunity_type", [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
]);
export const opportunityStatus = pgEnum("opportunity_status", [
  "upcoming",
  "open",
  "closed",
  "archived",
]);
export const reviewStatus = pgEnum("review_status", ["pending", "approved", "rejected"]);
export const ingestionMethod = pgEnum("ingestion_method", [
  "publisher_api",
  "submission",
  "scrape",
  "import",
  "outbox",
]);
export const orgType = pgEnum("org_type", [
  "foundation",
  "dao",
  "company",
  "protocol",
  "program",
  "individual",
  "other",
]);

// ── organizations (issuer / namespace; embedded on each opportunity) ─────────────
// NOTE: no `verified` flag in M2 — verification is a publishing-relationship concern (M3),
// not an issuer attribute (see FIELDS.md "organization").
export const organizations = pgTable("organizations", {
  id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  type: orgType(),
  description: text(),
  website: text(),
  logoUrl: text(),
  bannerUrl: text(),
  socialLinks: jsonb().$type<Record<string, string>>().notNull().default({}),
  ecosystems: text().array().notNull().default(sql`'{}'`),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ── opportunities (core; trimmed to the M2 read surface) ─────────────────────────
export const opportunities = pgTable(
  "opportunities",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    publicId: text().notNull().unique(), // Standard `id`, e.g. 'fundingmap:1459'
    specVersion: text().notNull().default("1.0.0"),
    type: opportunityType().notNull(),
    status: opportunityStatus().notNull(),

    title: text().notNull(),
    description: text().notNull(),
    summary: text(),

    organizationId: bigint({ mode: "number" })
      .notNull()
      .references(() => organizations.id),

    applicationUrl: text(),
    website: text(),
    logoUrl: text(),
    bannerUrl: text(),
    socialLinks: jsonb().$type<Record<string, string>>().notNull().default({}),

    // classification (open lists) — filtered via GIN
    ecosystems: text().array().notNull().default(sql`'{}'`),
    networks: text().array().notNull().default(sql`'{}'`),
    categories: text().array().notNull().default(sql`'{}'`),
    tags: text().array().notNull().default(sql`'{}'`),

    // funding envelope
    currency: text(),
    minAward: numeric(),
    maxAward: numeric(),
    totalBudget: numeric(),
    amountDistributed: numeric(),
    awardsToDate: integer(),

    // dates
    opensAt: timestamp({ withTimezone: true }),
    closesAt: timestamp({ withTimezone: true }),
    postedAt: timestamp({ withTimezone: true }),

    // discriminated-union payload (served under the `type` key) + escape hatch
    typeData: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    extensions: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    // provenance (required url)
    sourceUrl: text().notNull(),
    sourcePublisher: text(),
    sourceSubmittedBy: text(),
    sourceSubmittedAt: timestamp({ withTimezone: true }),
    ingestedVia: ingestionMethod(),
    sourceSystem: text(),
    originalId: text(),
    verifiedAgainstSource: boolean(),
    verifiedAt: timestamp({ withTimezone: true }),
    snapshotUrl: text(),

    // editorial / server-side (never in the public object)
    reviewStatus: reviewStatus().notNull().default("pending"),
    isListed: boolean().notNull().default(true),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // hot public query: approved + listed, ordered by deadline
    index("ix_opp_public_live")
      .on(t.status, t.closesAt)
      .where(sql`${t.reviewStatus} = 'approved' AND ${t.isListed}`),
    index("ix_opp_type").on(t.type),
    index("ix_opp_org").on(t.organizationId),
    index("ix_opp_closes_at").on(t.closesAt),
    index("ix_opp_budget").on(t.totalBudget),
    index("ix_opp_award").on(t.minAward, t.maxAward),
    index("ix_opp_updated").on(t.updatedAt.desc()),
    index("gin_opp_ecosystems").using("gin", t.ecosystems),
    index("gin_opp_networks").using("gin", t.networks),
    index("gin_opp_categories").using("gin", t.categories),
    index("gin_opp_tags").using("gin", t.tags),
    // cross-system idempotency key (also used by M3 outbox ingest)
    uniqueIndex("ux_opp_source").on(t.sourceSystem, t.originalId),
  ],
);

// ── dataset_snapshots (M2 nightly export bookkeeping) ────────────────────────────
export const datasetSnapshots = pgTable("dataset_snapshots", {
  id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  format: text().notNull(), // json | csv
  entryCount: integer().notNull(),
  url: text().notNull(),
  ipfsCid: text(),
  sha256: text(),
  specVersion: text().notNull(),
});

export type OrganizationRow = typeof organizations.$inferSelect;
export type OpportunityRow = typeof opportunities.$inferSelect;
export type OpportunityInsert = typeof opportunities.$inferInsert;
export type OrganizationInsert = typeof organizations.$inferInsert;
