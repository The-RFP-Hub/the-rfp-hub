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

/** Shared wording for pages gated by a global staff role. */
export const ROUTE_GATE_COPY = {
  reviewer: {
    title: "This account does not have Hub reviewer access.",
    label: "Hub reviewer access",
    role: "Hub reviewer",
  },
  admin: {
    title: "This account does not have Hub admin access.",
    label: "Hub admin access",
    role: "Hub admin",
  },
} as const;

/** Raw values retained by the audit disclosure, grouped here for its three rendering surfaces. */
export function auditTechnicalRecord(entry: AuditEntry) {
  return {
    action: entry.action,
    actorKind: entry.actorKind,
    changedFields: entry.changedFields,
    ...(entry.patch === undefined ? {} : { patch: entry.patch }),
  };
}
