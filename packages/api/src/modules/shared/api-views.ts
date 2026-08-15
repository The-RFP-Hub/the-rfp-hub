/**
 * The RESPONSE SHAPES of every M3 surface, in one place, as types.
 *
 * Each one is a closed OpenAPI component (`additionalProperties: false`), which means
 * fast-json-stringify silently DROPS anything a controller returns that the component does not
 * declare. A test cannot see that — it validates a body the serializer has already coerced to the
 * schema under test. What catches it is this file: the drift guard builds a sample of each type,
 * so adding a member here is a typecheck error until the sample is updated and a test failure until
 * the component declares it.
 *
 * Controllers therefore return these types, never object literals.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import type { AccountRole, ApiKeyScope } from "./capabilities.js";

// ── writes ───────────────────────────────────────────────────────────────────────
export interface SubmissionResultView {
  opportunity: Opportunity;
  /** True for a create (including a recognised identical repeat), false for a replace. */
  created: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  isListed: boolean;
  /**
   * Advisory check-tier findings. Never fatal — a conformant document may still carry them, and a
   * publisher who cannot see them cannot act on them.
   */
  warnings: string[];
}

// ── audit ────────────────────────────────────────────────────────────────────────
export interface AuditEntryView {
  action: string;
  at: string;
  actorKind: string;
  actor: string;
  changedFields: string[];
  /** Present only for the entry's submitter, its publisher and T3+. */
  patch?: Record<string, unknown>;
}

export interface AuditTrailView {
  entries: AuditEntryView[];
}

// ── duplicates and verification (populated by the dedupe and verification waves) ──
export interface DuplicateMatchView {
  /** The OTHER entry's public id. Only entries this viewer may see are ever listed. */
  id: string;
  title: string;
  similarity: number | null;
  status: "suspected" | "confirmed" | "dismissed" | "merged";
  detectedAt: string;
}

export interface DuplicateListView {
  items: DuplicateMatchView[];
}

export interface VerificationRunView {
  runAt: string;
  requestedUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  existsAtSource: boolean | null;
  matched: boolean | null;
  fieldDiff: Record<string, unknown> | null;
  extracted: Record<string, unknown> | null;
  snapshotSha256: string | null;
  error: string | null;
}

// ── claims ───────────────────────────────────────────────────────────────────────
export interface ClaimResultView {
  /** `granted` transferred publishing rights now; `queued` filed a claim for review. */
  outcome: "granted" | "queued" | "unchanged";
  claimId: number | null;
  opportunityId: string;
  organizationSlug: string;
  /**
   * What the outcome means for future writes. A grant on an UNVERIFIED organization transfers
   * ownership but does NOT unlock auto-approval, and saying so is the whole point of this member.
   */
  message: string;
}

export interface ClaimSummaryView {
  id: number;
  opportunityId: string;
  opportunityTitle: string;
  organizationSlug: string;
  organizationVerified: boolean;
  claimedBy: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ClaimListView {
  items: ClaimSummaryView[];
}

// ── publishers (public) ──────────────────────────────────────────────────────────
export interface PublisherView {
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  ecosystems: string[];
  verifiedAt: string | null;
}

export interface PublisherListView {
  items: PublisherView[];
  total: number;
}

// ── identity ─────────────────────────────────────────────────────────────────────
export interface MeMembershipView {
  slug: string;
  name: string;
  role: "owner" | "admin" | "publisher";
  verified: boolean;
}

export interface MeView {
  accountId: number;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  primaryWallet: string | null;
  role: AccountRole;
  directCreate: boolean;
  /** Which credential this request presented — the thing that decides half the authorization. */
  credentialKind: "session" | "api_key";
  scopes: ApiKeyScope[];
  memberships: MeMembershipView[];
  canManageKeys: boolean;
  canReview: boolean;
  canAdmin: boolean;
  createdAt: string;
}

export interface ApiKeyView {
  id: number;
  name: string | null;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyListView {
  items: ApiKeyView[];
}

export interface ApiKeyCreatedView {
  key: ApiKeyView;
  /** Shown EXACTLY ONCE. Not stored, not recoverable, never returned again. */
  token: string;
}

// ── review and admin ─────────────────────────────────────────────────────────────
export interface ManagedOpportunityView {
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

export interface ManagedOpportunityListView {
  items: ManagedOpportunityView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ReviewDecisionView {
  id: string;
  reviewStatus: string;
  isListed: boolean;
}

export interface AccountSummaryView {
  id: number;
  handle: string | null;
  displayName: string | null;
  globalRole: AccountRole;
  directCreate: boolean;
  createdAt: string;
}

export interface AccountListView {
  items: AccountSummaryView[];
}

export interface OrganizationSummaryView {
  slug: string;
  name: string;
  verified: boolean;
  verifiedAt: string | null;
  website: string | null;
  ecosystems: string[];
  memberCount: number;
}

export interface OrganizationListView {
  items: OrganizationSummaryView[];
}

export interface MembershipResultView {
  organizationSlug: string;
  accountId: number;
  role: "owner" | "admin" | "publisher" | null;
  /** False when the membership was revoked rather than granted. */
  member: boolean;
}
