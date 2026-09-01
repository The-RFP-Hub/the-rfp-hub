/**
 * The API's response shapes, hand-derived from its published OpenAPI components.
 *
 * WHY HAND-DERIVED AND NOT GENERATED. Generating from a live document would make a frontend build
 * depend on a running API, and generating from a checked-in copy would make this package own a
 * duplicate of a file the API already owns. Both were rejected. These are the shapes the frontend
 * actually reads, written once, in one file, with the API's own component names — so a drift shows
 * up as a typecheck error in the one module that touches the network (`lib/api.ts`) rather than as
 * `undefined` on a page.
 *
 * EVERY STRING IN HERE IS UNTRUSTED unless the comment says otherwise. Titles, descriptions,
 * handles and organization names are publisher-supplied; they are rendered as text nodes and never
 * as markup. See `components/UntrustedText.tsx`.
 */
import type {
  Deadline,
  Funding,
  FundingType,
  Milestone,
  Opportunity,
  OpportunityStatus,
  Organization,
  Provenance,
  SocialLink,
} from "@the-rfp-hub/standard";

export type {
  Deadline,
  Funding,
  FundingType,
  Milestone,
  Opportunity,
  OpportunityStatus,
  Organization,
  Provenance,
  SocialLink,
};

/** Review state. Editorial, server-owned, and not part of the Standard document. */
export type ReviewStatus = "pending" | "approved" | "rejected";
export type AccountRole = "submitter" | "reviewer" | "admin";
export type ApiKeyScope = "read" | "write" | "publish";
export type DuplicateStatus = "suspected" | "confirmed" | "dismissed" | "merged";
export type ClaimStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type OrgRole = "owner" | "admin" | "publisher";

export interface ValidationIssue {
  /** JSON Pointer, or `(root)` for a whole-document issue. */
  path: string;
  message: string;
}

/** `ErrorResponse` / `ValidationErrorResponse` — one shape, `errors` present only on the latter. */
export interface ApiErrorBody {
  error: string;
  message: string;
  /** One human-readable sentence per violation, produced by the Standard's own humanizer. */
  errors?: string[];
  /** Structured companions to `errors`, when the rejection can identify a field. */
  issues?: ValidationIssue[];
  /** Present on `survivor_already_merged`: the entry that really survived. */
  survivorId?: string;
  /** Present on the public detail route's enriched 404 for an id that used to be public. */
  mergedInto?: { id: string; title: string };
}

// ── the public directory ────────────────────────────────────────────────────────
/**
 * Strip the generated Standard type's `[k: string]: unknown` index signature, so `Omit` can drop a
 * named key from it. The same helper, for the same reason, as the API's own list mapper: without it
 * `Omit` sees `keyof` as bare `string` and produces an object with no named members at all.
 */
type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * `OpportunitySummary` — one row of `GET /v1/opportunities`.
 *
 * A full Standard opportunity MINUS `fundingDetails`, which the list projection omits as a delivery
 * concern (the detail route carries it). Derived from the Standard type rather than re-typed, so a
 * field the spec adds is a field this list can read without a second edit here.
 */
export type OpportunitySummary = Omit<RemoveIndex<Opportunity>, "fundingDetails">;

/** `PaginatedOpportunities` — the envelope `GET /v1/opportunities` serves the summaries in. */
export interface PaginatedOpportunities {
  items: OpportunitySummary[];
  page: number;
  limit: number;
  total: number;
  /** Always ≥ 1: an empty result is page 1 of 1, not page 1 of 0. */
  totalPages: number;
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
  /** Whether the other entry has a public detail page; otherwise use the entitled workbench. */
  isPublic: boolean;
  similarity: number | null;
  /**
   * Why this pair was flagged, as labels: the arm that decided (`lexical` or `overlap`) followed
   * by any structural evidence corroborating it. Empty on a pair recorded before reasons existed.
   */
  matchedOn: string[];
  status: DuplicateStatus;
  detectedAt: string;
}

export interface DuplicateList {
  items: DuplicateMatch[];
}

export interface OwnedDuplicateMatch extends DuplicateMatch {
  yourListing: { id: string; title: string };
}

export interface OwnedDuplicateList {
  items: OwnedDuplicateMatch[];
}

// ── notifications ──────────────────────────────────────────────────────────────
export type NotificationKind =
  | "duplicate_suspected"
  | "duplicate_confirmed"
  | "duplicate_dismissed"
  | "duplicate_merged_away"
  | "duplicate_absorbed"
  | "duplicate_reopened";

export interface DuplicateNotificationPayload {
  pairId: number;
  similarity: number | null;
  yourListing: { id: string; title: string };
  /** Omitted unless the counterpart was approved and listed when the event was recorded. */
  otherListing?: { id: string; title: string };
  action: "review_match" | "view_match" | "view_survivor";
  link: string;
  decidedBy: "reviewer" | null;
}

export interface Notification {
  id: number;
  kind: NotificationKind;
  subjectKind: "duplicate";
  subjectId: number;
  payload: DuplicateNotificationPayload;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationList {
  items: Notification[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  unreadCount: number;
}

export interface NotificationReadAll {
  markedRead: number;
  unreadCount: number;
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
  /** The detector's numeric decision inputs. Null on a pair written before the column existed. */
  signal: Record<string, unknown> | null;
  matchedOn: string[];
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
  /** A LOW-BAR anti-spam signal — the page exists and its title is about the same program. */
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
  claimedByAccountId: number | null;
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
  /**
   * The address the account signs in with. Still served — the API joins it from the auth user
   * record — even though the identity provider that used to supply it is gone.
   */
  email: string | null;
  role: AccountRole;
  directCreate: boolean;
  /** Which credential this request presented. The frontend always presents a session. */
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
  /** Returned EXACTLY ONCE. Never stored by this frontend, never re-fetchable. */
  token: string;
}

// ── review and admin ────────────────────────────────────────────────────────────
/**
 * The newest approve/reject on a listing, as its owner is entitled to see it.
 *
 * THIS IS WHAT ENDS "IT JUST DISAPPEARED". Before it existed, a rejected submission was findable but
 * mute: the owner could see the word `rejected` and nothing about why, and the only way to learn was
 * to ask a reviewer who had already written the answer down. Nothing new is stored for it — the
 * audit trail always held the action, the reason and the time — it is simply served now.
 *
 * `reason` is nullable and that is honest rather than a gap: an approval rarely carries one, and a
 * rejection made before the reason became mandatory has none to show.
 */
export interface ReviewDecisionSummary {
  action: "approve" | "reject";
  reason: string | null;
  at: string;
}

export interface ManagedOpportunity {
  id: string;
  title: string;
  fundingType: string;
  status: string;
  reviewStatus: string;
  isListed: boolean;
  namespace: string | null;
  submittedBy: string | null;
  submittedByAccountId: number | null;
  /** The merge survivor; its title is withheld while that survivor is not publicly visible. */
  mergedInto: { id: string; title: string | null } | null;
  /** The newest decision on this listing, or null while nobody has decided anything. */
  lastDecision: ReviewDecisionSummary | null;
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
  /** Returned by privileged account-directory searches. */
  email?: string | null;
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

export interface MembershipInvite {
  id: number;
  organizationSlug: string;
  email: string;
  role: OrgRole;
  invitedBy: number;
  createdAt: string;
  acceptedAt: string | null;
  acceptedAccountId: number | null;
}

export interface MembershipInviteList {
  items: MembershipInvite[];
}

/**
 * `GET /v1/health` — liveness, database readiness, and which sign-in methods this deployment has.
 *
 * `auth` is OPTIONAL here on purpose. A deployment running an older API answers without it, and the
 * sign-in screen has to tell "this deployment has no Google" apart from "this API does not say" —
 * the first hides the button, the second falls back to trying.
 */
export interface Health {
  status: string;
  db: string;
  auth?: { google?: boolean };
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
