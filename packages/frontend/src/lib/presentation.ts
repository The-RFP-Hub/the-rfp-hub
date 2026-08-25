/**
 * Display vocabulary for domain values that cross the API boundary.
 *
 * Wire values remain stable and machine-readable. These helpers are the one place the frontend
 * turns them into words for people, so a public page, a publisher workbench and a reviewer queue do
 * not quietly invent three names for the same state.
 */
import type { AccountRole, AuditEntry, DuplicateStatus, OrgRole, ReviewStatus } from "./types";

const FUNDING_TYPE_LABELS: Readonly<Record<string, string>> = {
  grant: "Grant",
  hackathon: "Hackathon",
  bounty: "Bounty",
  accelerator: "Accelerator",
  vc_fund: "Venture fund",
  rfp: "Request for proposals",
};

const OPPORTUNITY_STATUS_LABELS: Readonly<Record<string, string>> = {
  upcoming: "Upcoming",
  open: "Open",
  closed: "Closed",
  archived: "Archived",
};

const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  pending: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
};

const DUPLICATE_STATUS_LABELS: Readonly<Record<DuplicateStatus, string>> = {
  suspected: "Needs review",
  confirmed: "Confirmed match",
  dismissed: "Different programmes",
  merged: "Merged",
};

const INGESTION_METHOD_LABELS: Readonly<Record<string, string>> = {
  publisher_api: "Submitted with an API key",
  submission: "Submitted in the browser",
  scrape: "Imported from a website",
  import: "Imported dataset",
  outbox: "Synced from a source system",
};

/** Display-only role labels. Authorization and payload values continue to use the wire tokens. */
const ACCOUNT_ROLE_LABELS: Readonly<Record<AccountRole, string>> = {
  submitter: "Submitter",
  reviewer: "Hub reviewer",
  admin: "Hub admin",
};

/** Organisation roles are disambiguated, not re-ranked or renamed into a new hierarchy. */
const ORG_ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: "Organisation owner",
  admin: "Organisation admin",
  publisher: "Organisation publisher",
};

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "Submitted",
  update: "Updated",
  approve: "Approved",
  reject: "Rejected",
  relist: "Made visible in the directory",
  unlist: "Hidden from the directory",
  merge: "Merged",
  close: "Closed",
  claim: "Claimed",
  confirm_duplicate: "Confirmed as a match",
  dismiss_duplicate: "Marked as different programmes",
  verify_source: "Checked the source",
  verify_organization: "Verified the organisation",
  unverify_organization: "Removed organisation verification",
  update_organization: "Updated the organisation",
  grant_publisher: "Granted organisation membership",
  revoke_publisher: "Revoked organisation membership",
  assign_role: "Changed the account role",
  create_api_key: "Created an API key",
  revoke_api_key: "Revoked an API key",
};

const AUDIT_FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "Identifier",
  title: "Title",
  summary: "Summary",
  description: "Description",
  fundingType: "Funding type",
  fundingInfo: "Funding",
  fundingDetails: "Funding details",
  deadlines: "Deadlines",
  milestones: "Milestones",
  operatingOrganizations: "Running organisations",
  sponsors: "Sponsors",
  status: "Application stage",
  applicationUrl: "Application link",
  opensAt: "Opening date",
  postedAt: "Announcement date",
  updatedAt: "Last updated",
  eligibility: "Eligibility",
  prerequisites: "Application requirements",
  serviceAgreement: "Service agreement",
  additionalReferences: "Further references",
  categories: "Categories",
  ecosystems: "Ecosystems",
  tags: "Tags",
  contact: "Contact",
  source: "Source",
  socialLinks: "Social links",
  customFields: "Additional details",
  reviewStatus: "Review decision",
  isListed: "Public visibility",
  reason: "Reason",
  actorRole: "Acting role",
  merged: "Merged listing",
  mergedInto: "Merged into",
  copiedFields: "Copied fields",
  role: "Role",
  directCreate: "Direct-create access",
  verified: "Organisation verification",
};

/** Humanize an unknown future token deterministically while leaving its wire form available below. */
function fallbackLabel(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? value : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function fundingTypeLabel(value: string): string {
  return FUNDING_TYPE_LABELS[value] ?? fallbackLabel(value);
}

export function opportunityStatusLabel(value: string): string {
  return OPPORTUNITY_STATUS_LABELS[value] ?? fallbackLabel(value);
}

export function reviewStatusLabel(value: string): string {
  return REVIEW_STATUS_LABELS[value as ReviewStatus] ?? fallbackLabel(value);
}

export function duplicateStatusLabel(value: string): string {
  return DUPLICATE_STATUS_LABELS[value as DuplicateStatus] ?? fallbackLabel(value);
}

export function ingestionMethodLabel(value: string | null | undefined): string {
  if (!value?.trim()) return "Not stated";
  return INGESTION_METHOD_LABELS[value] ?? fallbackLabel(value);
}

export function accountRoleLabel(value: AccountRole): string {
  return ACCOUNT_ROLE_LABELS[value];
}

export function orgRoleLabel(value: OrgRole): string {
  return ORG_ROLE_LABELS[value];
}

export function auditActionLabel(value: string): string {
  return AUDIT_ACTION_LABELS[value] ?? fallbackLabel(value);
}

/** Field paths may be nested; the first segment is the useful human category for a compact table. */
export function auditFieldLabel(value: string): string {
  const topLevel = value.split(/[./[]/, 1)[0] ?? value;
  return AUDIT_FIELD_LABELS[topLevel] ?? fallbackLabel(topLevel);
}

/** The actor's public label, without leaking the transport-shaped `actorKind` token into prose. */
export function auditActorLabel(actor: string, actorKind: string): string {
  if (actor === "reviewer") return "Hub reviewer";
  if (actor === "job" || actorKind === "job") return "Automated job";
  if (actor === "outbox" || actorKind === "outbox") return "Source system";
  if (actor === "community") return "Community submission";
  if (actorKind === "api_key") return `${actor} via API key`;
  return actor;
}

export type PublisherStatus = "merged" | "rejected" | "pending" | "hidden" | "live";

export interface PublisherStatusSource {
  mergedInto?: unknown;
  reviewStatus: string;
  isListed: boolean;
}

/** The single publisher-facing state, ordered so terminal editorial facts always win. */
export function publisherStatus(source: PublisherStatusSource): PublisherStatus {
  if (source.mergedInto !== null && source.mergedInto !== undefined) return "merged";
  if (source.reviewStatus === "rejected") return "rejected";
  if (source.reviewStatus === "pending") return "pending";
  if (source.reviewStatus === "approved" && !source.isListed) return "hidden";
  return "live";
}

export const PUBLISHER_STATUS_LABELS: Readonly<Record<PublisherStatus, string>> = {
  merged: "Merged",
  rejected: "Rejected",
  pending: "Waiting for review",
  hidden: "Hidden from directory",
  live: "Live",
};

export function isOpenDuplicateStatus(status: DuplicateStatus): boolean {
  return status === "suspected" || status === "confirmed";
}

export interface GateCopy {
  title: string;
  detail: string;
}

/**
 * What each signed-out route needs an account for.
 *
 * These are route facts rather than auth vocabulary: the gate should name the work waiting behind
 * it, not make every signed-out destination sound like the same generic dashboard.
 */
export const ROUTE_GATE_COPY = {
  listings: {
    title: "Sign in to manage your listings.",
    detail: "See what is waiting for review, live, rejected, merged, or hidden.",
  },
  newListing: {
    title: "Sign in to submit an opportunity.",
    detail: "After signing in, you can restore any draft saved for this account on this device.",
  },
  listing: {
    title: "Sign in to view this listing.",
    detail: "See its review status, history, matches, and publishing controls.",
  },
  editListing: {
    title: "Sign in to edit this listing.",
    detail: "Open the saved listing and the account controls available to you.",
  },
  account: {
    title: "Sign in to view your account.",
    detail: "See your Hub role and verified organisation memberships.",
  },
  organisations: {
    title: "Sign in to view your organisations.",
    detail: "See the organisations where this account has publishing rights.",
  },
  organisation: {
    title: "Sign in to view this organisation.",
    detail: "Check your membership and manage the listings in its namespace.",
  },
  duplicates: {
    title: "Sign in to review matches involving your listings.",
    detail: "These matches are private to listing owners and reviewers.",
  },
  keys: {
    title: "Sign in to manage API keys.",
    detail: "API keys can publish or update listings on your behalf.",
  },
  review: {
    title: "Sign in with a Hub reviewer account.",
    detail: "Review submissions, claims, organisations, and duplicate matches.",
  },
  admin: {
    title: "Sign in with a Hub administrator account.",
    detail: "Manage Hub roles and direct-publishing access.",
  },
} as const satisfies Record<string, GateCopy>;

/** Dashboard keeps its richer hand-written signed-out state, but shares the route-first tone. */
export const DASHBOARD_GATE_COPY: GateCopy = {
  title: "Sign in to view your listings’ traffic.",
  detail: "See aggregate directory opens and outbound clicks for published listings.",
};

/** Capability refusals are account facts, distinct from the signed-out route invitation above. */
export const CAPABILITY_DENIAL_COPY = {
  reviewer: {
    title: "This account does not have Hub reviewer access.",
    detail: "Review submissions, claims, organisations, and duplicate matches requires that role.",
  },
  admin: {
    title: "This account does not have Hub administrator access.",
    detail: "Managing Hub roles and direct-publishing access requires that role.",
  },
  keyManagement: {
    title: "This account does not have API key management access.",
    detail: "Only an account allowed to manage API keys can open this page.",
  },
} as const satisfies Record<string, GateCopy>;

/** Raw values retained by the audit disclosure, grouped here for its three rendering surfaces. */
export function auditTechnicalRecord(entry: AuditEntry) {
  return {
    action: entry.action,
    actorKind: entry.actorKind,
    changedFields: entry.changedFields,
    ...(entry.patch === undefined ? {} : { patch: entry.patch }),
  };
}
