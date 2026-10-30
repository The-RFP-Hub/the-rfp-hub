/**
 * WHEN A LINK-OUT MAY VOUCH FOR ITS DESTINATION — pure, no DB, no HTTP, unit-tested.
 *
 * `/v1/r/:id/apply` and `/source` count a click and hop to a URL stored on the entry. The hop is on
 * this project's own domain, and a reader who clicks a link on rfpsear.ch and arrives somewhere
 * reads the arrival as ours: we sent them. That is a promise about the DESTINATION, and the stored
 * URL alone cannot keep it —
 *
 *   - a verified publisher's write is auto-approved, so it can repoint a link nobody looked at;
 *   - a closed or archived programme still has its link, and dead programmes are exactly where an
 *     expired domain gets re-registered by somebody else;
 *   - a link can start landing somewhere new without the stored text changing at all — a
 *     shortener retargeted, a programme page that now redirects to another site.
 *
 * A static host allowlist was considered and rejected: most apply links live on multi-tenant hosts
 * (airtable.com, typeform.com, tally.so …), so an attacker's form on the same host passes it too.
 *
 * So the rule is about REVIEW, not about hosts: the hop goes straight through only for a link a
 * person reviewed and that has not changed since. Everything else goes to the frontend's "leaving"
 * page, which shows the destination and the reason and lets the reader continue. The failure mode
 * is therefore one extra click — never a blocked one — which is what makes it safe for this rule to
 * err towards caution.
 */
import type { OpportunityStatus } from "@the-rfp-hub/standard";

/** The two link-outs, and which stored column each one means. */
export type LinkKind = "apply" | "source";

/**
 * Why a link-out is not vouched for. Part of the CONTRACT with the frontend's leaving page, which
 * renders a sentence per value — adding one is a change on both sides.
 */
export type LeavingReason = "closed" | "unreviewed" | "landing_changed";

/** What the rule needs to know about one entry's link, all of it read from the stored row. */
export interface LinkOutFacts {
  /** The stored URL — `application_url` or `website`, as stored. */
  stored: string;
  /** What a reviewer last vouched for in the same column; NULL when nobody ever did. */
  reviewed: string | null;
  status: OpportunityStatus;
  /** When the source check saw the apply link land on a different site. Apply only. */
  landingChangedAt: Date | null;
}

/**
 * The reason a reader should see the leaving page first, or `null` when the hop may go straight
 * through. PRECEDENCE IS PART OF THE CONTRACT, and it runs from the reason a reader most needs to
 * hear to the one that is most often a false alarm:
 *
 *   1. `closed` — `closed` or `archived`. Whatever the link once was, the programme is over, and
 *      that is true even of a link a reviewer pinned yesterday.
 *   2. `unreviewed` — the stored URL is not, byte for byte, the one a reviewer last vouched for
 *      (including "never vouched"). Exact equality on purpose: the pin is a copy of the very same
 *      column, so any difference at all is a write nobody reviewed.
 *   3. `landing_changed` — APPLY ONLY. The source check fetches `applicationUrl` and nothing else,
 *      so it has never observed where `website` lands, and must not speak for it.
 */
export function leavingReason(kind: LinkKind, facts: LinkOutFacts): LeavingReason | null {
  if (facts.status === "closed" || facts.status === "archived") return "closed";
  if (facts.reviewed === null || facts.stored !== facts.reviewed) return "unreviewed";
  if (kind === "apply" && facts.landingChangedAt !== null) return "landing_changed";
  return null;
}

/**
 * The frontend's leaving page for one link-out.
 *
 * BUILT FROM `APP_BASE_URL`, which is configuration, and the entry's STORED public id — nothing in
 * it is a caller-supplied URL, so it is as closed to open-redirect abuse as the stored link is. The
 * id is percent-encoded because public ids carry a `:` (`fundingmap:1459`), and a path segment
 * holding a raw colon is one a router may read as a scheme. `kind` and `reason` are closed
 * vocabularies, so they need no encoding.
 */
export function leavingPageUrl(
  appBaseUrl: string,
  publicId: string,
  kind: LinkKind,
  reason: LeavingReason,
): string {
  return `${appBaseUrl}/leaving/${encodeURIComponent(publicId)}?link=${kind}&reason=${reason}`;
}

/**
 * The columns a reviewer's decision writes: both links pinned to what the row now stores, and the
 * landing flag cleared — the reviewer is vouching for where the link goes TODAY, which is the only
 * thing that can retire a landing change.
 *
 * Shared by every writer that pins (the review decision and a reviewer's own save), so "what a
 * reviewer vouches for" has one definition.
 */
export function reviewerPins(urls: {
  applicationUrl?: string | null;
  website?: string | null;
}): {
  reviewedApplicationUrl: string | null;
  reviewedWebsite: string | null;
  linkLandingChangedAt: null;
} {
  return {
    reviewedApplicationUrl: urls.applicationUrl ?? null,
    reviewedWebsite: urls.website ?? null,
    linkLandingChangedAt: null,
  };
}
