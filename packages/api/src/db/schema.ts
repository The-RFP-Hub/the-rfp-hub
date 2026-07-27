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
import type { Contact, Deadline, Milestone, Organization } from "@the-rfp-hub/standard";
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

// ── jsonb payload types ────────────────────────────────────────────────────────
// The jsonb columns below store Standard sub-objects verbatim, so their types come FROM the
// Standard and are never redefined here. They are re-declared as locally-named interfaces purely
// so TypeScript's declaration emit can name them: `@the-rfp-hub/standard` ships a bundled `.d.ts` in
// which these interfaces are internally renamed (`Organization$1`, …) and therefore unnameable
// from the outside, which trips TS4023 on Drizzle's inferred table types.
// (A plain `type X = Organization` alias does NOT fix TS4023 — the alias still resolves to the
// unnameable declaration. An interface declared here is a new, local, exported symbol.)
export interface StoredOrganization extends Organization {}
export interface StoredContact extends Contact {}
export interface StoredDeadline extends Deadline {}
export interface StoredMilestone extends Milestone {}

// ── Enums ──────────────────────────────────────────────────────────────────────
/** The Standard's `fundingType` discriminator (six values, unchanged by the re-cut). */
export const fundingType = pgEnum("funding_type", [
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

// ── organizations (directory / namespace registry) ───────────────────────────────
// Since the re-cut an opportunity carries ARRAYS of organizations (`sponsoringOrganizations`,
// `operatingOrganizations`) whose order is semantic, so the arrays themselves are stored on the
// opportunity as jsonb (see below) and reads never join. This table stays the canonical org
// directory — it is upserted on every ingest and is what M3's `/publishers`, `verified` flag and
// `org_memberships` hang off. See docs/data-model.md "Organizations".
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
  contacts: jsonb().$type<StoredContact[]>().notNull().default([]),
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
    fundingType: fundingType().notNull(),
    status: opportunityStatus().notNull(),

    title: text().notNull(),
    description: text().notNull(),
    summary: text(),

    // Organizations are arrays with SEMANTIC ORDER ([0] = primary/display) and each may carry
    // `contacts[]`, so they are stored verbatim as jsonb and served back unchanged.
    // No DB default: the Standard requires minItems 1, so every insert must supply it.
    sponsoringOrganizations: jsonb().$type<StoredOrganization[]>().notNull(),
    operatingOrganizations: jsonb().$type<StoredOrganization[]>().notNull().default([]),
    // Denormalized, GIN-indexed lookup key for the `organization` filter: one entry per SPONSORING
    // organization (`slug`, or a slugified `name` when the publisher omitted one). Maintained on
    // write — the filter therefore matches ANY sponsor, not just the primary one.
    sponsorSlugs: text().array().notNull().default(sql`'{}'`),

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

    // open key→value eligibility map + free-text qualifiers (not filterable by design)
    eligibility: jsonb().$type<Record<string, string>>().notNull().default({}),
    prerequisites: text(),
    resourceLinks: text(),
    serviceAgreement: text(),

    // funding envelope
    currency: text(),
    minAward: numeric(),
    maxAward: numeric(),
    budget: numeric(),
    /** Amount COMMITTED to date (NOT disbursed) — the re-cut's `funding.allocated`. */
    allocated: numeric(),

    /** Milestone sequence; ARRAY ORDER IS THE SEQUENCE (no order/index field in the Standard). */
    milestones: jsonb().$type<StoredMilestone[]>().notNull().default([]),

    // dates
    opensAt: timestamp({ withTimezone: true }),
    /** Every deadline / event boundary, each `{type: fixed|rolling, date?, label?}`. */
    deadlines: jsonb().$type<StoredDeadline[]>().notNull().default([]),
    /**
     * DERIVED + DENORMALIZED: the earliest FUTURE `fixed` deadline, or NULL when the record has
     * none (rolling-only, all-past, or no deadlines at all). Exists purely so deadline sorting and
     * the deadline-window filters are indexable; recomputed on every write from `deadlines`.
     * See `modules/shared/deadlines.ts`.
     */
    nextDeadlineAt: timestamp({ withTimezone: true }),
    postedAt: timestamp({ withTimezone: true }),

    // discriminated-union payload (served under the `fundingType` key) + escape hatch
    typeData: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    extensions: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    // provenance — since the re-cut the Standard's `source` has NO required field (source.url was
    // removed outright); `applicationUrl` is the single link-back target.
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
    // hot public query: approved + listed, ordered by the next fixed deadline
    index("ix_opp_public_live")
      .on(t.status, t.nextDeadlineAt)
      .where(sql`${t.reviewStatus} = 'approved' AND ${t.isListed}`),
    index("ix_opp_funding_type").on(t.fundingType),
    index("ix_opp_next_deadline").on(t.nextDeadlineAt),
    index("ix_opp_budget").on(t.budget),
    index("ix_opp_award").on(t.minAward, t.maxAward),
    index("ix_opp_updated").on(t.updatedAt.desc()),
    index("gin_opp_ecosystems").using("gin", t.ecosystems),
    index("gin_opp_networks").using("gin", t.networks),
    index("gin_opp_categories").using("gin", t.categories),
    index("gin_opp_tags").using("gin", t.tags),
    index("gin_opp_sponsors").using("gin", t.sponsorSlugs),
    // cross-system idempotency key (M3 outbox/import). PARTIAL: only rows that carry BOTH a source
    // system and original id are deduped; source-less community submissions stay unconstrained
    // (a plain unique would let NULL rows coexist, but this makes the intent explicit).
    uniqueIndex("ux_opp_source")
      .on(t.sourceSystem, t.originalId)
      .where(sql`${t.sourceSystem} IS NOT NULL AND ${t.originalId} IS NOT NULL`),
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
