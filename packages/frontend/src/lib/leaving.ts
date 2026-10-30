/**
 * The model behind `/leaving/[id]`: which stored link the page is about, why the reader was sent
 * there, and whether that link may be offered at all.
 *
 * WHAT THE PAGE IS FOR. `GET /v1/r/{id}/apply` (and `/source`) is a counted 302 to a URL a
 * publisher stored. For most listings that is exactly right. For some it is not something this
 * site should do silently: a link nobody reviewed, a programme that has closed, a link that started
 * landing somewhere else. For those the API sends the reader here instead, with the query
 * `?link=apply|source&reason=closed|unreviewed|landing_changed`, and this page shows them where
 * the link goes before they go.
 *
 * THE DESTINATION IS NEVER READ FROM THE ADDRESS BAR, and that is the whole security surface. The
 * query only says WHICH of the listing's two links and WHY; the URL itself is read from the public
 * listing, by id, through the same read the detail page makes. A `/leaving/` URL that carried its
 * destination would be an open redirect with a reassuring page in front of it — a phishing
 * primitive wearing this site's name — and nothing a third party can put in the query changes
 * where "Continue" goes.
 *
 * FAILING SAFE MEANS ONE EXTRA CLICK, NEVER A BLOCKED ONE. Every value this module does not
 * recognise degrades to the most general wording rather than to an error: an unknown `link` is the
 * application link (the one the API sends almost every reader through), an unknown or missing
 * `reason` is "we can't vouch for this link right now". A future API that adds a fourth reason
 * before this page learns it still gets a page that shows the destination and lets the reader on.
 */
import type { Opportunity } from "@/lib/types";
import { isPublishableUrl } from "@/lib/url-policy";

export const LEAVING_LINKS = ["apply", "source"] as const;
export type LeavingLink = (typeof LEAVING_LINKS)[number];

export const LEAVING_REASONS = ["closed", "unreviewed", "landing_changed"] as const;
export type LeavingReason = (typeof LEAVING_REASONS)[number];

export interface LeavingQuery {
  link: LeavingLink;
  /** `null` when the reason is missing or one this page does not know. */
  reason: LeavingReason | null;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Read the two parameters this page understands, and nothing else.
 *
 * Exact matches only — no trimming, no case folding. The API writes these values and writes them
 * one way; anything else did not come from it, and the cost of not recognising it is the general
 * wording, which is still true.
 */
export function readLeavingQuery(params: Pick<URLSearchParams, "get">): LeavingQuery {
  return {
    link: oneOf(LEAVING_LINKS, params.get("link")) ?? "apply",
    reason: oneOf(LEAVING_REASONS, params.get("reason")),
  };
}

/**
 * Why the reader is looking at this page instead of the destination, in the site's own voice.
 *
 * Each sentence states what we know and stops there. "Unreviewed" does not mean "unsafe" and
 * "landing changed" does not mean "hijacked"; saying more than the check established would teach
 * readers to ignore the page the first time it is wrong.
 */
export const REASON_COPY: Record<LeavingReason, string> = {
  closed:
    "This program is closed. The link may no longer work, and the site behind it may have changed hands since the listing was reviewed.",
  unreviewed:
    "This link was added or changed after the listing was last reviewed, and nobody here has checked it yet.",
  landing_changed:
    "When we last checked this link, it sent visitors to a different site than it did before.",
};

export const UNKNOWN_REASON_COPY = "We can’t vouch for this link right now.";

export function reasonCopy(reason: LeavingReason | null): string {
  return reason === null ? UNKNOWN_REASON_COPY : REASON_COPY[reason];
}

/** What the link is, in the words the page uses for it — with its article, which differs. */
export const LINK_WORDS: Record<LeavingLink, { definite: string; indefinite: string }> = {
  apply: { definite: "The application link", indefinite: "an application link" },
  source: {
    definite: "The link to the program’s site",
    indefinite: "a link to the program’s site",
  },
};

/**
 * The stored URL this page may offer as "Continue", or `null` when it must not offer one.
 *
 * `applicationUrl` for `apply`, `website` for `source` — the same two columns the API's redirect
 * reads, so the page and the redirect can never disagree about which link a reader asked for.
 *
 * `isPublishableUrl` is the gate, not a nicety: it is the API's own rule for what it will store
 * and redirect to (`https://`, `http://` only on loopback, authority form). A value that fails it
 * can only be here because something upstream let it through, and this page is not where that gets
 * waved on — the reader gets "This link isn't available" and the way back to the listing.
 */
export function leavingDestination(
  entry: Pick<Opportunity, "applicationUrl" | "website">,
  link: LeavingLink,
): string | null {
  const stored = link === "source" ? entry.website : entry.applicationUrl;
  if (typeof stored !== "string" || stored.trim() === "") return null;
  return isPublishableUrl(stored) ? stored : null;
}
