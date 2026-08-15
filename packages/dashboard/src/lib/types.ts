/**
 * The API's response shapes, hand-derived from its published OpenAPI components.
 *
 * WHY HAND-DERIVED AND NOT GENERATED. Generating from a live document would make a dashboard build
 * depend on a running API, and generating from a checked-in copy would make this package own a
 * duplicate of a file the API already owns. Both were rejected. These are the shapes the dashboard
 * actually reads, written once, in one file, with the API's own component names — so a drift shows
 * up as a typecheck error in the one module that touches the network (`lib/api.ts`) rather than as
 * `undefined` on a page.
 *
 * EVERY STRING IN HERE IS UNTRUSTED unless the comment says otherwise. Titles, descriptions,
 * handles and organisation names are publisher-supplied; they are rendered as text nodes and never
 * as markup. See `components/UntrustedText.tsx`.
 */
import type { Opportunity } from "@the-rfp-hub/standard";

export type { Opportunity };

/** Review state. Editorial, server-owned, and not part of the Standard document. */
export type ReviewStatus = "pending" | "approved" | "rejected";
export type AccountRole = "submitter" | "reviewer" | "admin";
export type ApiKeyScope = "read" | "write" | "publish";
export type DuplicateStatus = "suspected" | "confirmed" | "dismissed" | "merged";
export type ClaimStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type OrgRole = "owner" | "admin" | "publisher";

/** `ErrorResponse` / `ValidationErrorResponse` — one shape, `errors` present only on the latter. */
export interface ApiErrorBody {
  error: string;
  message: string;
  /** One human-readable sentence per violation, produced by the Standard's own humanizer. */
  errors?: string[];
  /** Present on `survivor_already_merged`: the entry that really survived. */
  survivorId?: string;
}

// ── writes ──────────────────────────────────────────────────────────────────────
/**
 * Whether the duplicate pass RAN — a different question from whether it found anything.
 *
 * `ok` with an empty `duplicates` is the only combination that means "checked, nothing similar".
 * A form that reads an empty array as "clean" reports a clean bill of health for a submission
 * nothing ever looked at, so all three states are surfaced separately in the UI.
 */
export type DuplicateCheckStatus = "ok" | "unavailable" | "disabled";

export interface SubmissionResult {
  opportunity: Opportunity;
  created: boolean;
  reviewStatus: ReviewStatus;
  isListed: boolean;
  /** Advisory check-tier findings. Never fatal. */
  warnings: string[];
  duplicateCheck: DuplicateCheckStatus;
  duplicates: DuplicateMatch[];
}

// ── audit ───────────────────────────────────────────────────────────────────────
export interface AuditEntry {
  action: string;
  at: string;
  actorKind: string;
  actor: string;
  changedFields: string[];
  /** Present only for the entry's submitter, its publisher and reviewers. */
  patch?: Record<string, unknown>;
}

export interface AuditTrail {
  entries: AuditEntry[];
}

// ── duplicates ──────────────────────────────────────────────────────────────────
export interface DuplicateMatch {
  /** The OTHER entry's public id. */
  id: string;
  title: string;
  similarity: number | null;
  status: DuplicateStatus;
  detectedAt: string;
}

export interface DuplicateList {
  items: DuplicateMatch[];
}

export interface DuplicateSide {
  id: string;
  title: string;
  reviewStatus: ReviewStatus;
  isListed: boolean;
  namespace: string | null;
  mergedInto: string | null;
  updatedAt: string;
}

export interface DuplicatePair {
  /** The PAIR's own id — what `/v1/review/duplicates/{id}/…` names. Not an opportunity id. */
  id: number;
  status: DuplicateStatus;
  similarity: number | null;
  detectedAt: string;
  reviewedAt: string | null;
  left: DuplicateSide;
  right: DuplicateSide;
}

export interface DuplicatePairList {
  items: DuplicatePair[];
}

export interface MergeResult {
  pair: DuplicatePair;
  survivorId: string;
  mergedId: string;
  copiedFields: string[];
}

// ── verification ────────────────────────────────────────────────────────────────
export interface VerificationRun {
  runAt: string;
  requestedUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  existsAtSource: boolean | null;
  /** A LOW-BAR anti-spam signal — the page exists and its title is about the same programme. */
  matched: boolean | null;
  fieldDiff: Record<string, unknown> | null;
  extracted: Record<string, unknown> | null;
  snapshotSha256: string | null;
  error: string | null;
}

// ── insights ────────────────────────────────────────────────────────────────────
export interface InsightsTotals {
  listViews: number;
  detailViews: number;
  sourceClicks: number;
  applyClicks: number;
}

export interface InsightsPoint extends InsightsTotals {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
}

export interface InsightsSeries {
  opportunityId: string;
  title: string;
  from: string;
  to: string;
  totals: InsightsTotals;
  /** One row per day in the window, zero-filled — a gap-free series the chart maps directly. */
  days: InsightsPoint[];
}

export interface InsightsEntry extends InsightsTotals {
  opportunityId: string;
  title: string;
}

export interface InsightsSummary {
  from: string;
  to: string;
  totals: InsightsTotals;
  /** Sorted by `detailViews` descending by the API. */
  opportunities: InsightsEntry[];
}

// ── claims ──────────────────────────────────────────────────────────────────────
export interface ClaimResult {
  outcome: "granted" | "queued" | "unchanged";
  claimId: number | null;
  opportunityId: string;
  organizationSlug: string;
  /** States what the outcome means for FUTURE writes. Display it; do not paraphrase it. */
  message: string;
}

export interface ClaimSummary {
  id: number;
  opportunityId: string;
  opportunityTitle: string;
  organizationSlug: string;
  organizationVerified: boolean;
  claimedBy: string;
  status: ClaimStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ClaimList {
  items: ClaimSummary[];
}

// ── identity ────────────────────────────────────────────────────────────────────
export interface MeMembership {
  slug: string;
  name: string;
  role: OrgRole;
  verified: boolean;
}

export interface Me {
  accountId: number;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  primaryWallet: string | null;
  role: AccountRole;
  directCreate: boolean;
  /** Which credential this request presented. The dashboard always presents a session. */
  credentialKind: "session" | "api_key";
  scopes: ApiKeyScope[];
  memberships: MeMembership[];
  canManageKeys: boolean;
  canReview: boolean;
  canAdmin: boolean;
  createdAt: string;
}

export interface ApiKey {
  id: number;
  name: string | null;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyList {
  items: ApiKey[];
}

export interface ApiKeyCreated {
  key: ApiKey;
  /** Returned EXACTLY ONCE. Never stored by this dashboard, never re-fetchable. */
  token: string;
}

// ── review and admin ────────────────────────────────────────────────────────────
export interface ManagedOpportunity {
  id: string;
  title: string;
  fundingType: string;
  status: string;
  reviewStatus: string;
  isListed: boolean;
  namespace: string | null;
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedOpportunityList {
  items: ManagedOpportunity[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ReviewDecision {
  id: string;
  reviewStatus: string;
  isListed: boolean;
}

export interface AccountSummary {
  id: number;
  handle: string | null;
  displayName: string | null;
  globalRole: AccountRole;
  directCreate: boolean;
  createdAt: string;
}

export interface AccountList {
  items: AccountSummary[];
}

export interface OrganizationSummary {
  slug: string;
  name: string;
  verified: boolean;
  verifiedAt: string | null;
  website: string | null;
  ecosystems: string[];
  memberCount: number;
}

export interface OrganizationList {
  items: OrganizationSummary[];
}

export interface MembershipResult {
  organizationSlug: string;
  accountId: number;
  role: OrgRole | null;
  member: boolean;
}

// ── publishers (public) ─────────────────────────────────────────────────────────
export interface Publisher {
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  ecosystems: string[];
  verifiedAt: string | null;
}

export interface PublisherList {
  items: Publisher[];
  total: number;
}
