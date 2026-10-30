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
 * `reason` changes nothing, because no reason is ever shown as a fact. A future API that adds a fourth
 * reason before this page learns it still gets a page that shows the destination and lets the
 * reader on.
 */
import type { Opportunity } from "@/lib/types";
import { isPublishableUrl } from "@/lib/url-policy";

export const LEAVING_LINKS = ["apply", "source"] as const;
export type LeavingLink = (typeof LEAVING_LINKS)[number];

export const LEAVING_REASONS = ["closed", "unreviewed", "landing_changed"] as const;
export type LeavingReason = (typeof LEAVING_REASONS)[number];

export interface LeavingQuery {
  link: LeavingLink;
  /**
   * `null` when the reason is missing or one this page does not know. Informational only: the
   * notice never states a fact on the strength of it (see `noticeCopy`).
   */
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
 * What the security notice says, in the site's own voice.
 *
 * THE NOTICE STATES ONLY WHAT THE LISTING ITSELF SAYS, never what the query claims. Anyone can
 * write `/leaving/{an-open-listing}?reason=closed`, and a page that then announced "This program
 * is closed" would be asserting a fact on this site's behalf with nothing behind it but the
 * address bar. So `reason` is read (it is the API's contract) and trusted for nothing: the one
 * fact the notice states — the program is closed — comes from the listing's own `status`, read
 * from the API with the destination. Everything else gets the plain notice, which is true for
 * every link. "The link now lands somewhere else" is deliberately not said at all: the public
 * listing carries no record of earlier checks, so the page has nothing to back it with.
 */
export const SECURITY_NOTICE =
  "For your security, RFPSear.ch shows you where a link goes before you leave the site.";

export const CLOSED_NOTICE =
  "This program is closed. The link may no longer work, or the site behind it may have changed hands.";

export function noticeCopy(entry: Pick<Opportunity, "status">): string {
  return entry.status === "closed" || entry.status === "archived" ? CLOSED_NOTICE : SECURITY_NOTICE;
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
