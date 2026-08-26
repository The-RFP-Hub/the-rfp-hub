/**
 * RFP Hub `/v1/` API — Drizzle schema.
 *
 * This is the IMPLEMENTED slice of the full design in `packages/api/docs/data-model.md`, which
 * remains the canonical design target. M2 implemented the read layer (`organizations`,
 * `opportunities`, `dataset_snapshots`); M3 adds identity (`accounts`, `api_keys`,
 * `org_memberships`), the generalized append-only `audit_log`, claims, verification runs, pgvector
 * embeddings, duplicate pairs and the analytics pair.
 *
 * Still DEFERRED to M4, each with its reason recorded in data-model.md: `ingestion_events` (the
 * outbox), `PARTITION BY RANGE` on the analytics table (drizzle-kit cannot generate partition DDL,
 * and retention — the real motive — is a bounded DELETE), the generated `tsvector` column and the
 * `type_data` GIN index.
 *
 * Column names are written camelCase here and mapped to snake_case in SQL via Drizzle
 * `casing: "snake_case"` (configured in drizzle.config.ts and the runtime client).
 */
import type { Contact, Deadline, Milestone, Organization, SocialLink } from "@the-rfp-hub/standard";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

// Better-Auth's own tables (`auth_user`/`auth_session`/`auth_account`/`auth_verification`) live in
// their own file — see auth-schema.ts's header for why — and are re-exported here so this remains
// the single module drizzle-kit and the runtime client point at.
export * from "./auth-schema.js";

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
export interface StoredSocialLink extends SocialLink {}

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

// ── M3 enums ───────────────────────────────────────────────────────────────────
/**
 * The GLOBAL role on an account: T1, T3, T4.
 *
 * T2 (verified publisher) is deliberately absent. It is not a role — it is a membership on a
 * verified organization, held per namespace, so the same account is T2 in one namespace and T1 in
 * the next within a single request. A role column could only record one answer.
 */
export const accountRole = pgEnum("account_role", ["submitter", "reviewer", "admin"]);

/** An account's role WITHIN one organization. */
export const orgRole = pgEnum("org_role", ["owner", "admin", "publisher"]);

/** What kind of thing performed an audited action. */
export const actorKind = pgEnum("actor_kind", ["user", "api_key", "job", "outbox"]);

/**
 * What an audit row is ABOUT.
 *
 * `opportunity_audit` could only reference an opportunity (its FK was `NOT NULL`), so role grants,
 * organization verification, membership changes and key revocation had nothing to point at and
 * were simply unrecordable. The subject is therefore polymorphic — see `auditLog`.
 */
export const auditSubjectKind = pgEnum("audit_subject_kind", [
  "opportunity",
  "organization",
  "account",
  "api_key",
  "claim",
  "duplicate",
]);

/**
 * Every audited action.
 *
 * Enumerated in full now, rather than grown one migration at a time: adding a value to a Postgres
 * enum is a separate `ALTER TYPE … ADD VALUE`, and an audit trail whose vocabulary lags the code
 * records the wrong verb for whatever landed first.
 */
export const auditAction = pgEnum("audit_action", [
  // opportunities
  "create",
  "update",
  "approve",
  "reject",
  "unlist",
  "relist",
  "close",
  "reopen",
  "verify_source",
  "merge",
  // duplicates
  "confirm_duplicate",
  "dismiss_duplicate",
  // claims and publishing rights
  "claim",
  "grant_publisher",
  "revoke_publisher",
  "invite_member",
  "accept_member_invite",
  "revoke_member_invite",
  // organizations
  "verify_organization",
  "unverify_organization",
  "update_organization",
  // accounts and credentials
  "assign_role",
  "grant_direct_create",
  "revoke_direct_create",
  "create_api_key",
  "revoke_api_key",
]);

/**
 * A claim's lifecycle. `approved` is the granted state, whether the grant was immediate (the
 * organization was already verified and operates the entry) or made by a reviewer afterwards.
 */
export const claimStatus = pgEnum("claim_status", ["pending", "approved", "rejected", "withdrawn"]);

export const dupStatus = pgEnum("dup_status", ["suspected", "confirmed", "dismissed", "merged"]);

/** Durable events emitted by the duplicate workflow and rendered by in-app and email channels. */
export const notificationKind = pgEnum("notification_kind", [
  "duplicate_suspected",
  "duplicate_confirmed",
  "duplicate_dismissed",
  "duplicate_merged_away",
  "duplicate_absorbed",
  "duplicate_reopened",
]);

export const analyticsEvent = pgEnum("analytics_event", [
  "list_view",
  "detail_view",
  "source_click",
  "apply_click",
]);

// ── organizations (directory / namespace registry) ───────────────────────────────
// Since the re-cut an opportunity carries ARRAYS of organizations (`sponsoringOrganizations`,
// `operatingOrganizations`) whose order is semantic, so the arrays themselves are stored on the
// opportunity as jsonb (see below) and reads never join. This table stays the canonical org
// directory — it is upserted on every ingest and is what M3's `/publishers`, `verified` flag and
// `org_memberships` hang off. See docs/data-model.md "Organizations".
export const organizations = pgTable("organizations", {
  id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  orgType: orgType(),
  description: text(),
  website: text(),
  logoUrl: text(),
  bannerUrl: text(),
  socialLinks: jsonb().$type<StoredSocialLink[]>().notNull().default([]),
  ecosystems: text().array().notNull().default(sql`'{}'`),
  contacts: jsonb().$type<StoredContact[]>().notNull().default([]),
  /**
   * Approved-publisher status. This is the flag T2 hangs off: a membership on a VERIFIED
   * organization is what makes a write into that namespace auto-approve, and `/publishers` lists
   * exactly the rows where this is true.
   *
   * It is a publishing-RELATIONSHIP fact, not an attribute of the issuer — the directory holds
   * plenty of organizations nobody here has any relationship with, because every operating and
   * sponsoring organization named on any entry is upserted into it. Default false, and only a
   * reviewer sets it.
   */
  verified: boolean().notNull().default(false),
  verifiedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ── accounts (principals) ────────────────────────────────────────────────────────
export const accounts = pgTable("accounts", {
  id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  /**
   * The identity provider's subject — `auth_user.id`. THE join key, and the only one. Drop-in
   * replacement for the former `privy_did`: still an opaque provider-issued string, so
   * `resolveBy…`, `grant-admin`, `db-seed` and `accounts.search` keep their shapes.
   *
   * NO FOREIGN KEY, deliberately. An `accounts` row must outlive a deleted `auth_user` row —
   * `audit_log` points at THIS table's id, never at Better-Auth's, and a cascaded delete over
   * there must never be able to silently orphan or erase history over here.
   */
  authUserId: text().unique(),
  displayName: text(),
  /**
   * The public identifier used for attribution: `source.submittedBy` becomes this handle, the
   * publishing organization's slug, or `"community"`. Public, so it is deliberately not the email
   * or the auth subject.
   */
  handle: text().unique(),
  globalRole: accountRole().notNull().default("submitter"),
  /**
   * Publish in ANY namespace without a membership, granted by an admin and audited both ways.
   * Independent of `globalRole`: reviewing is not publishing, and an account can have either
   * without the other.
   */
  directCreate: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ── api_keys ─────────────────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    accountId: bigint({ mode: "number" })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text(),
    /** The public 8-character identifier. Shown in a UI and in an audit row; not a secret. */
    keyPrefix: text().notNull(),
    /**
     * `sha256(full token)`, hex. The secret is shown once at mint and stored nowhere, so a
     * disclosure of this table yields nothing usable. See `modules/shared/api-key-token.ts` for
     * why a plain digest rather than a KDF (the secret is 256 bits of CSPRNG output).
     */
    keyHash: text().notNull(),
    scopes: text().array().notNull().default(sql`'{read}'`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    /**
     * Revocation is SOFT. An audit row records which key acted (`audit_log.actor_api_key_id`), and
     * a hard delete would leave those rows pointing at nothing — which is precisely the question
     * soft revocation exists to keep answerable.
     */
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ux_api_keys_hash").on(t.keyHash),
    index("ix_api_keys_account").on(t.accountId),
  ],
);

// ── org_memberships (an account's publishing rights on an organization) ──────────
// There is no separate publisher entity: "publisher" is an account holding a membership on a
// verified organization. One account may hold memberships on many organizations.
export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    accountId: bigint({ mode: "number" })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: bigint({ mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: orgRole().notNull().default("publisher"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ux_org_membership").on(t.accountId, t.organizationId),
    // The hot lookup is "which organizations does this principal publish for", resolved on every
    // authenticated write.
    index("ix_org_membership_account").on(t.accountId),
  ],
);

// ── org_membership_invites (publishing rights waiting for a verified sign-in) ────
export const orgMembershipInvites = pgTable(
  "org_membership_invites",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    organizationId: bigint({ mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Normalized to lowercase by the service; the partial index also lowers defensively. */
    email: text().notNull(),
    role: orgRole().notNull().default("publisher"),
    invitedBy: bigint({ mode: "number" })
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedAccountId: bigint({ mode: "number" }).references(() => accounts.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("ux_org_membership_invite_pending")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null`),
    index("ix_org_membership_invite_pending_email")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null`),
    index("ix_org_membership_invite_organization").on(t.organizationId, t.createdAt),
  ],
);

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
    // `operatingOrganizations` is THE primary array ([0] = display org): the Standard requires it
    // with minItems 1, so it has no DB default — every insert must supply it. Sponsors are
    // optional and may be empty, hence the `[]` default.
    sponsoringOrganizations: jsonb().$type<StoredOrganization[]>().notNull().default([]),
    operatingOrganizations: jsonb().$type<StoredOrganization[]>().notNull(),
    // Denormalized, GIN-indexed lookup key for the `organization` filter: the UNION of every
    // operating AND sponsoring organization slug (slug is Standard-required). Maintained on
    // write — the filter therefore matches either role, not just the primary [0] entry.
    orgSlugs: text().array().notNull().default(sql`'{}'`),

    applicationUrl: text(),
    website: text(),
    logoUrl: text(),
    bannerUrl: text(),
    socialLinks: jsonb().$type<StoredSocialLink[]>().notNull().default([]),

    // classification (open lists) — filtered via GIN
    ecosystems: text().array().notNull().default(sql`'{}'`),
    categories: text().array().notNull().default(sql`'{}'`),

    // free-flow eligibility text + free-text qualifiers (not filterable by design)
    eligibility: text(),
    prerequisites: text(),
    additionalReferences: text(),
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
    /** Every deadline / event boundary, each `{deadlineType: fixed|rolling, date?, label?}`. */
    deadlines: jsonb().$type<StoredDeadline[]>().notNull().default([]),
    /**
     * DERIVED + DENORMALIZED: the earliest FUTURE `fixed` deadline, or NULL when the record has
     * none (rolling-only, all-past, or no deadlines at all). Exists purely so deadline sorting and
     * the deadline-window filters are indexable; recomputed on every write from `deadlines`.
     * See `modules/shared/deadlines.ts`.
     */
    nextDeadlineAt: timestamp({ withTimezone: true }),
    postedAt: timestamp({ withTimezone: true }),

    // discriminated-union payload (served under the `fundingType` key)
    typeData: jsonb().$type<Record<string, unknown>>().notNull().default({}),

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
    /**
     * Who submitted it, and who approved it.
     *
     * `ON DELETE SET NULL`, not cascade: an account going away must never take published entries
     * with it. The permanent record of who did what is `audit_log`, which carries no foreign keys
     * at all for the same reason one step further.
     */
    submittedBy: bigint({ mode: "number" }).references(() => accounts.id, {
      onDelete: "set null",
    }),
    approvedBy: bigint({ mode: "number" }).references(() => accounts.id, { onDelete: "set null" }),
    approvedAt: timestamp({ withTimezone: true }),
    /**
     * The last time a publisher touched this entry, or a verification confirmed it at source.
     *
     * The staleness job's clock. Any publisher write, granted claim or successful verification
     * resets it, so an entry that nobody has re-asserted for `STALENESS_INACTIVE_DAYS` and that
     * carries no future fixed deadline is closed as inactive — including a rolling-only entry,
     * which is exactly the listing that would otherwise stay open forever.
     */
    lastSeenAt: timestamp({ withTimezone: true }),
    /**
     * Set on the LOSER of a merge, pointing at the survivor.
     *
     * The row is kept rather than deleted: its public id may already be in an export, a feed or
     * someone's bookmarks, and a public id that used to resolve may still tell a client where the
     * listing went. A survivor that itself carries this is refused as a merge target, which is what
     * prevents chains and cycles.
     */
    mergedIntoId: bigint({ mode: "number" }).references((): AnyPgColumn => opportunities.id, {
      onDelete: "set null",
    }),
    /**
     * Whether the LOSER was public at the instant it was merged.
     *
     * This is intentionally stored rather than reconstructed from the loser's terminal state: the
     * merge itself rejects, unlists and archives that row. False by default means rows merged before
     * this provenance bit existed reveal nothing conservatively.
     */
    mergedFromPublic: boolean().notNull().default(false),

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
    index("gin_opp_categories").using("gin", t.categories),
    index("gin_opp_org_slugs").using("gin", t.orgSlugs),
    // cross-system idempotency key (M3 outbox/import). PARTIAL: only rows that carry BOTH a source
    // system and original id are deduped; source-less community submissions stay unconstrained
    // (a plain unique would let NULL rows coexist, but this makes the intent explicit).
    uniqueIndex("ux_opp_source")
      .on(t.sourceSystem, t.originalId)
      .where(sql`${t.sourceSystem} IS NOT NULL AND ${t.originalId} IS NOT NULL`),
    // The staleness job's selection predicate walks open entries by how long they have been
    // untouched; without this it is a sequential scan of the whole table every night.
    index("ix_opp_last_seen").on(t.lastSeenAt),
    // "What has this account submitted" — the dashboard's own listings page, and the only way an
    // owner can see their pending and rejected entries at all.
    index("ix_opp_submitted_by").on(t.submittedBy),
    // The publisher lookup that decides auto-approval and claim conflicts.
    index("ix_opp_source_publisher").on(t.sourcePublisher),
  ],
);

// ── audit_log (one generalized, append-only history) ─────────────────────────────
/**
 * Every mutation, whatever it was about.
 *
 * This REPLACES the design's `opportunity_audit`, whose `opportunity_id` was `NOT NULL` — so a
 * role assignment, an organization verification, a membership change and a key revocation had
 * nothing to reference and were simply unrecordable. Adding action names to that table would not
 * have fixed a mandatory column; the subject had to become polymorphic.
 *
 * TWO PROPERTIES ARE LOAD-BEARING AND NEITHER IS OBVIOUS:
 *
 * 1. **No foreign keys.** A polymorphic `subject_id` cannot carry one — but that is not the real
 *    reason. The real reason is that an `ON DELETE CASCADE` somewhere else must never be able to
 *    erase history without a delete against this table ever being issued. Derived children
 *    (verification runs, embeddings, duplicates, events) keep their cascades; history does not.
 *    `actor_api_key_id` likewise has no FK, and revocation is soft, so an audit row always names
 *    a key that still resolves.
 *
 * 2. **Append-only is enforced by the DATABASE**, by a `BEFORE UPDATE OR DELETE` trigger shipped
 *    as a migration — not asserted by a test and not left to a `REVOKE` that a given deployment
 *    may or may not have run. A test proves the code path; the trigger holds for every path,
 *    including a developer at a psql prompt. The `REVOKE` is defence in depth on top
 *    (`scripts/sql/harden-audit.sql`).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    subjectKind: auditSubjectKind().notNull(),
    subjectId: bigint({ mode: "number" }).notNull(),
    /** NULL for a job or an outbox delivery, which act on nobody's behalf. */
    actorAccountId: bigint({ mode: "number" }),
    /**
     * WHICH key acted. `actor_kind='api_key'` plus an account id cannot answer that, and it is
     * the question asked first when a key is suspected of having leaked.
     */
    actorApiKeyId: bigint({ mode: "number" }),
    actorKind: actorKind().notNull(),
    /**
     * The role the actor held WHEN THEY ACTED — and the reason the public trail can promise a
     * reviewer anonymity.
     *
     * The public actor label coarsens an editorial action to `"reviewer"` and credits everyone else
     * by handle. Deriving that from `accounts.global_role` at READ time makes the promise expire:
     * demote a reviewer and their handle appears retroactively on every entry they ever rejected,
     * and promote a submitter and their own past submissions stop being theirs. A role is
     * revocable; what it was at the moment of the action is not.
     *
     * NULL for a job, an outbox delivery and for every row written before this column existed.
     * Those older rows are NOT backfilled: `audit_log` refuses `UPDATE` (migration 0004), and
     * defeating the trigger that makes the history trustworthy in order to rewrite the history is a
     * worse trade than the read-time fallback, which is what those rows keep.
     */
    actorRole: accountRole(),
    action: auditAction().notNull(),
    /** `{field: {before, after}}` — see `modules/shared/patch.ts`. Field names only, publicly. */
    patch: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The trail for one subject, newest first — the only read shape this table has.
    index("ix_audit_subject").on(t.subjectKind, t.subjectId, t.createdAt.desc()),
    index("ix_audit_actor").on(t.actorAccountId, t.createdAt.desc()),
  ],
);

// ── opportunity_claims ───────────────────────────────────────────────────────────
/**
 * A request to become the publisher of an entry somebody else submitted.
 *
 * Granted immediately when the claiming organization is verified AND its slug appears among the
 * entry's OPERATING organizations. Operating, not `org_slugs`: that column is the union including
 * SPONSORS, and a sponsor is not an operator — matching on it would let a sponsoring organization
 * seize publisher ownership of somebody else's programme. Anything else is queued here for review.
 */
export const opportunityClaims = pgTable(
  "opportunity_claims",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    opportunityId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    organizationId: bigint({ mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The member who filed it. The claim is the ORGANIZATION's; this records who acted. */
    accountId: bigint({ mode: "number" }).references(() => accounts.id, { onDelete: "set null" }),
    status: claimStatus().notNull().default("pending"),
    note: text(),
    decidedBy: bigint({ mode: "number" }).references(() => accounts.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One pending claim per (entry, ORGANIZATION) — keyed on the organization, not the account.
     *
     * Keyed on the account instead, three colleagues at one organization file three claims for the
     * same entry while one person who belongs to two organizations cannot file the two DISTINCT
     * claims they legitimately have. The organization is the claimant; the account is the actor.
     */
    uniqueIndex("ux_claim_pending")
      .on(t.opportunityId, t.organizationId)
      .where(sql`${t.status} = 'pending'`),
    index("ix_claim_status").on(t.status, t.createdAt.desc()),
  ],
);

// ── verification_runs (append-only source-check log) ─────────────────────────────
/**
 * One fetch of an entry's `applicationUrl`, and what it said.
 *
 * A FAILED run is recorded too — a refused address, a timeout, a soft 404 — because "we tried and
 * this is what happened" is the answer a reviewer needs, and silence is indistinguishable from
 * never having run.
 */
export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    opportunityId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The URL actually fetched, and where the redirect chain ended. */
    requestedUrl: text(),
    finalUrl: text(),
    httpStatus: integer(),
    existsAtSource: boolean(),
    /** Title, metadata and JSON-LD read off the page (`modules/shared/html-extract.ts`). */
    extracted: jsonb().$type<Record<string, unknown>>(),
    /** Field-by-field presence against the submission (`modules/shared/field-diff.ts`). */
    fieldDiff: jsonb().$type<Record<string, unknown>>(),
    /** → `opportunities.verified_against_source`. A low-bar anti-spam signal, not a fact-check. */
    matched: boolean(),
    /**
     * THE SNAPSHOT OF RECORD for M3: the extracted plain text, plus a digest of the RAW BYTES that
     * produced it.
     *
     * Raw HTML is deliberately not stored — it is large, it is not what a reviewer reads, and it
     * would be an XSS liability the moment any future surface rendered it. The digest is what
     * makes the stored text checkable against the original.
     *
     * `snapshot_url` is redefined by this change: it is now an OPTIONAL external archive pointer
     * (IPFS / archive pinning), deferred to M4, and it is NOT what M3 produces. That redefinition
     * is stated in docs/data-model.md rather than left implicit.
     */
    snapshotText: text(),
    snapshotSha256: text(),
    snapshotUrl: text(),
    /** Why a run produced no page: a refused address, a timeout, an unusable content type. */
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_verification_opp").on(t.opportunityId, t.runAt.desc())],
);

// ── opportunity_embeddings (pgvector) ────────────────────────────────────────────
export const opportunityEmbeddings = pgTable(
  "opportunity_embeddings",
  {
    opportunityId: bigint({ mode: "number" })
      .primaryKey()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    /** The model AND the provider: two providers' vectors are not in comparable spaces. */
    model: text().notNull(),
    providerId: text().notNull(),
    embedding: vector({ dimensions: 1536 }).notNull(),
    /** `sha256(text + model + provider)` — what says whether this row is still current. */
    contentHash: text().notNull(),
    /**
     * The PRE-NORMALISATION L2 norm of `embedding`, and the distinct-token count behind it.
     *
     * NULLABLE IS THE DESIGN, not an omission. A row written before these columns existed has a
     * perfectly valid vector and an unknown magnitude, and "unknown" must degrade to "the overlap
     * arm is not evaluated for this pair" — never to "these entries are dissimilar", which would
     * delete real pairs. `embedding-backfill` repairs them on its first pass after deploy; the
     * predicate that selects them is gated on the provider actually being able to supply them
     * (`EmbeddingProvider.suppliesNorm`), so a provider that cannot never selects rows it cannot
     * fix.
     *
     * The norm is what a unit vector throws away, and it is what makes a length-corrected
     * comparison possible: cosine alone cannot tell a 40 %-truncated re-listing from an unrelated
     * entry, because normalisation has already erased the difference in length.
     */
    norm: doublePrecision(),
    tokenCount: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // HNSW over cosine distance. Cosine because the providers return normalised vectors and the
    // threshold is expressed as a cosine similarity; HNSW rather than IVFFlat because it needs no
    // training pass and stays correct as rows arrive one submission at a time.
    index("ix_opp_embed").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ── opportunity_duplicates ───────────────────────────────────────────────────────
export const opportunityDuplicates = pgTable(
  "opportunity_duplicates",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    opportunityId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    duplicateOfId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    similarity: numeric(),
    /**
     * The NUMERIC decision inputs — `{ arm, lexical, overlap, minTokens }`.
     *
     * The values the decision was actually made on, so the row stays interpretable after the
     * thresholds move. Nullable because every pair written before this column existed has none;
     * the read mapper renders that as "no reasons recorded", never as an absent field or a crash.
     *
     * DELIBERATELY NO STRUCTURAL SUB-OBJECT. A stored "same application URL" would be a fact about
     * two rows at one instant, and it goes stale the moment either is edited. Structural labels are
     * computed at READ time from the live rows, and they were never part of the decision anyway.
     */
    signal: jsonb().$type<Record<string, unknown>>(),
    /**
     * Which rule produced this row (`RULES_VERSION` in `services/dedupe/duplicate-signal.ts`).
     *
     * Without it, turning an arm off — or moving a threshold — strands every pair the old rule
     * wrote: pruning only ever runs for entries the backfill selects, so with nothing pending
     * those rows linger indefinitely. `embedding-backfill`'s resweep arm selects on
     * `rules_version IS DISTINCT FROM <current>` and re-evaluates or deletes, which is what turns
     * the feature switch into an actual rollback. NULL is every pre-versioning pair.
     */
    rulesVersion: smallint(),
    status: dupStatus().notNull().default("suspected"),
    reviewedBy: bigint({ mode: "number" }).references(() => accounts.id, { onDelete: "set null" }),
    detectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    /**
     * A pair is UNORDERED, so it is stored ordered.
     *
     * `UNIQUE (opportunity_id, duplicate_of_id)` permits (A,B) and (B,A) to coexist: the same pair
     * twice, with two independent statuses, so dismissing one leaves the other suspected. Indexing
     * the canonical ordering makes the mirrored form the same key.
     */
    uniqueIndex("ux_dup_pair").on(
      sql`least(${t.opportunityId}, ${t.duplicateOfId})`,
      sql`greatest(${t.opportunityId}, ${t.duplicateOfId})`,
    ),
    index("ix_dup_status").on(t.status, t.detectedAt.desc()),
    index("ix_dup_of").on(t.duplicateOfId),
    // Nothing is its own duplicate, and a self-pair would make the merge path try to merge a row
    // into itself.
    check("ck_dup_not_self", sql`${t.opportunityId} <> ${t.duplicateOfId}`),
  ],
);

// ── notifications (account inbox + email delivery state) ───────────────────────
/**
 * One durable account-scoped notification.
 *
 * The payload is structured data, never presentation copy. `subject_kind` remains text because it
 * is a polymorphic extension seam; this first slice writes only `duplicate`. The four-column
 * unique key is the final idempotency guard when a detector re-runs or a reviewer repeats an
 * action. After commit, a bounded in-process queue attempts email without making the request wait;
 * the nightly notification-dispatch job sweeps anything it misses. These timestamps remain the
 * source of truth for both paths.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    accountId: bigint({ mode: "number" })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: notificationKind().notNull(),
    subjectKind: text().notNull(),
    subjectId: bigint({ mode: "number" }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp({ withTimezone: true }),
    emailDispatchedAt: timestamp({ withTimezone: true }),
    emailFailedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ux_notification_event").on(t.accountId, t.kind, t.subjectKind, t.subjectId),
    index("ix_notification_account_created").on(t.accountId, t.createdAt.desc(), t.id.desc()),
    index("ix_notification_account_unread")
      .on(t.accountId, t.createdAt.desc())
      .where(sql`${t.readAt} is null`),
  ],
);

// ── analytics: raw events + the daily rollup ─────────────────────────────────────
/**
 * One recorded read or link-out. A PLAIN table, not partitioned.
 *
 * `PARTITION BY RANGE (occurred_at)` is in the design and is deferred to M4 with its reason:
 * drizzle-kit cannot generate partition DDL, so it would have to be hand-written and then kept in
 * step by hand forever; at this volume it buys nothing; and retention — the actual motive — is a
 * bounded `DELETE … WHERE occurred_at < now() - interval` in the nightly sweep, which needs no
 * partitions. The migration path when volume warrants it (create partitioned, copy, swap) is
 * recorded in docs/data-model.md.
 *
 * Capture is SERVER-SIDE only. There is no public beacon in this cut: an unauthenticated event
 * endpoint lets anyone fabricate a publisher's numbers, and rate limiting is not integrity.
 */
export const opportunityEvents = pgTable(
  "opportunity_events",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    opportunityId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    eventType: analyticsEvent().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Keyed HMACs, rotating daily — never a digest of the address. See shared/analytics-hash.ts. */
    sessionHash: text(),
    ipHash: text(),
    /** HOST only. A full referring URL is a page somebody was reading. */
    referrer: text(),
  },
  (t) => [
    // The rollup and the live "today so far" aggregate both read this shape.
    index("ix_event_opp_day").on(t.opportunityId, t.occurredAt),
    // The retention sweep deletes by age alone, across every entry.
    index("ix_event_occurred").on(t.occurredAt),
  ],
);

/** The rollup the dashboard reads. One column per event type — a merged `views` loses which. */
export const opportunityStatsDaily = pgTable(
  "opportunity_stats_daily",
  {
    opportunityId: bigint({ mode: "number" })
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    listViews: integer().notNull().default(0),
    detailViews: integer().notNull().default(0),
    sourceClicks: integer().notNull().default(0),
    applyClicks: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.day] })],
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

export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
export type OrgMembershipRow = typeof orgMemberships.$inferSelect;
export type OrgMembershipInviteRow = typeof orgMembershipInvites.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type OpportunityClaimRow = typeof opportunityClaims.$inferSelect;
export type VerificationRunRow = typeof verificationRuns.$inferSelect;
export type VerificationRunInsert = typeof verificationRuns.$inferInsert;
export type OpportunityEmbeddingRow = typeof opportunityEmbeddings.$inferSelect;
export type OpportunityDuplicateRow = typeof opportunityDuplicates.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type OpportunityEventInsert = typeof opportunityEvents.$inferInsert;
export type OpportunityStatsDailyRow = typeof opportunityStatsDaily.$inferSelect;
