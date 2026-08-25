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
/**
 * Whether duplicate detection RAN, which is a different question from whether it found anything.
 *
 * `ok` with an empty `duplicates` means "checked, nothing similar". `unavailable` means the
 * embedding call failed or timed out and the backfill job still owes this entry a check.
 * `disabled` means the deployment has no provider configured. Without this member a client cannot
 * tell the three apart, and would read every one of them as "no duplicates".
 */
export type DuplicateCheckStatus = "ok" | "unavailable" | "disabled";

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
  duplicateCheck: DuplicateCheckStatus;
  /**
   * Suspected matches, searched over PUBLICLY VISIBLE entries only.
   *
   * A submitter's duplicate check must never answer with somebody else's pending or unlisted title
   * and id — that would make the endpoint a way to enumerate the review queue.
   */
  duplicates: DuplicateMatchView[];
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

/**
 * One side of a pair, as the REVIEW queue sees it.
 *
 * The submitter-facing `DuplicateMatchView` names only the other entry and only when it is public.
 * A reviewer decides between two entries, so they get both sides and the editorial state that
 * decides which one may survive a merge.
 */
export interface DuplicateSideView {
  id: string;
  title: string;
  reviewStatus: "pending" | "approved" | "rejected";
  isListed: boolean;
  namespace: string | null;
  /** The survivor of an earlier merge, when this entry has already lost one. */
  mergedInto: string | null;
  updatedAt: string;
}

export interface DuplicatePairView {
  /** The PAIR's own id — what `/v1/review/duplicates/:id/…` names. Not an opportunity id. */
  id: number;
  status: "suspected" | "confirmed" | "dismissed" | "merged";
  similarity: number | null;
  detectedAt: string;
  reviewedAt: string | null;
  left: DuplicateSideView;
  right: DuplicateSideView;
}

export interface DuplicatePairListView {
  items: DuplicatePairView[];
}

export interface MergeResultView {
  pair: DuplicatePairView;
  /** The entry that remains public. */
  survivorId: string;
  /** The entry that was rejected, unlisted, archived and pointed at the survivor. */
  mergedId: string;
  /** Which whitelisted fields were carried over. Empty by default — a merge copies nothing. */
  copiedFields: string[];
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

// ── insights (publisher analytics) ───────────────────────────────────────────────
/**
 * The four counts, kept apart rather than merged into one `views`.
 *
 * A publisher's question is not "how much traffic" — it is "did anyone actually click through to
 * apply". A single merged number cannot answer that, and once merged it cannot be unmerged.
 *
 * WHAT THESE MEASURE: API reads and link-outs, not page views. Our own automation is excluded by
 * name, crawlers and `DNT: 1` are dropped, capture is buffered in memory and therefore crash-lossy,
 * and feeds and exports are never instrumented at all. Best-effort, and every surface says so.
 */
export interface InsightsTotalsView {
  listViews: number;
  detailViews: number;
  sourceClicks: number;
  applyClicks: number;
}

export interface InsightsPointView extends InsightsTotalsView {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
}

export interface InsightsSeriesView {
  opportunityId: string;
  title: string;
  from: string;
  to: string;
  totals: InsightsTotalsView;
  /**
   * One row per day in the window, zero-filled — a day with no traffic is a zero, not a gap, and a
   * chart drawn from a sparse series draws the wrong shape.
   *
   * Every day before today is the rollup; today is a live aggregate over the raw events, so traffic
   * from an hour ago is visible now rather than tomorrow.
   */
  days: InsightsPointView[];
}

export interface InsightsEntryView extends InsightsTotalsView {
  opportunityId: string;
  title: string;
}

export interface InsightsSummaryView {
  from: string;
  to: string;
  totals: InsightsTotalsView;
  opportunities: InsightsEntryView[];
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
  /**
   * The verified address the account signs in with, read from the identity tables rather than
   * stored here — see `me.controller.ts`. Null only for an API-key credential, which resolves an
   * account without resolving a session.
   */
  email: string | null;
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
/**
 * The newest review decision on an entry, as its owner is entitled to see it.
 *
 * The trail already records this — action, reason and time — so nothing new is stored for it. What
 * changes is that a submitter can finally READ why their entry was rejected, instead of finding it
 * missing and having to ask.
 */
export interface ReviewDecisionSummaryView {
  action: "approve" | "reject";
  /** Whatever the decider wrote, when they wrote one. Null is honest, not an error. */
  reason: string | null;
  at: string;
}

export interface ManagedOpportunityView {
  id: string;
  title: string;
  fundingType: string;
  status: string;
  reviewStatus: string;
  isListed: boolean;
  namespace: string | null;
  submittedBy: string | null;
  /** The public listing this archived record was merged into, with its current title. */
  mergedInto: { id: string; title: string } | null;
  /** The newest approve/reject on this entry, or null while nobody has decided anything. */
  lastDecision: ReviewDecisionSummaryView | null;
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

/**
 * One scheduled job's run, as `POST /v1/admin/jobs/{job}/run` reports it.
 *
 * `skipped` distinguishes the two ways a run correctly does nothing — another run held the
 * advisory lock (`locked`), or the feature the job serves is not configured — from a run that did
 * nothing because there was nothing to do (`processed: 0`, no `skipped`).
 */
export interface JobRunResultView {
  job: string;
  shape: "cursor" | "sweep";
  processed: number;
  /** What the job's predicate still matches. Always 0 for a sweep, by definition. */
  remaining: number;
  skipped?: string;
  passes: number;
  elapsedMs: number;
  details?: Record<string, number>;
}
