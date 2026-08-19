/**
 * "← Back to where you actually came from", as a URL parameter rather than as browser history.
 *
 * WHY NOT `history.back()`. A reviewer opens a listing from the queue, edits it, lands on the edit
 * page, saves, and is now three entries deep in a history stack whose top is not the queue. Browser
 * back walks that stack one step at a time; it cannot offer a LABEL, so it cannot say where it goes;
 * and it is wrong outright when the detail page was reached from a link somebody pasted. The origin
 * knows where it is, so the origin says so.
 *
 * WHY IT CARRIES THE ORIGIN'S QUERY. A reviewer on `/review?tab=organisations`, or an organisation
 * page on page 3 of its queue, has state in the address. Returning to `/review` would be returning
 * to a different screen than the one they left, which is the specific failure this exists to fix.
 *
 * THE SECURITY PROPERTY, which is the whole reason this is a module and not a template literal at
 * four call sites: THE PARAMETER IS ATTACKER-CONTROLLED. Anyone can send anyone a link to
 * `/listings/x?back=<anything>`. Rendered naively that is an open redirect wearing this
 * application's chrome — a "← Back to your listings" button that navigates to a credential-harvesting
 * page. So a value is used only when it is a path on this origin AND under a route this application
 * actually has, and everything else is dropped silently rather than shown as an error: a malformed
 * `back` is not something the reader did or can fix.
 */

export const RETURN_PARAM = "back";
export const RETURN_LABEL_PARAM = "backLabel";

/**
 * The route prefixes a return link may point at.
 *
 * Deliberately NOT "any path on this origin". `/` and `/opportunities/…` are public reading
 * surfaces nobody navigates back to from a workbench detail page, and the sign-in completion route
 * must never be a navigation target at all. An allowlist that has to be extended on purpose is the
 * point.
 */
const ALLOWED_PREFIXES = ["/review", "/organisations", "/listings", "/duplicates"] as const;

/** A publisher-supplied organisation name could be any length; a nav label may not be. */
const MAX_LABEL = 60;

/**
 * Whether `value` is a path this application may navigate back to.
 *
 * The three rejections that matter, in order of how often they are forgotten:
 *   - `//evil.example` — starts with `/`, and is a PROTOCOL-RELATIVE URL to another origin. This is
 *     the one that turns a naive `startsWith("/")` check into an open redirect.
 *   - `/\evil.example` — a backslash, which some URL parsers normalise to `/`, giving the same
 *     thing by a different spelling.
 *   - control characters, which can truncate or smuggle past a later parser.
 */
export function isSafeReturnPath(value: string): boolean {
  if (value === "" || !value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const pathname = value.split(/[?#]/)[0] ?? "";
  // `===` or a `/` boundary: `/listings` and `/listings/x` are ours, `/listingsevil` is not.
  if (
    !ALLOWED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  ) {
    return false;
  }
  /*
   * AND IT HAS TO BE DECODABLE.
   *
   * `/organisations/%E0%A4%A` passes every check above — it is a relative path under a route we own
   * — and then throws `URIError` the moment anything calls `decodeURIComponent` on it. That call
   * happens while deriving the link's label, i.e. DURING RENDER, from a parameter any stranger can
   * put in a link. A malformed escape was an attacker-controlled crash of the whole page.
   *
   * Rejected here rather than caught at the call site, so there is one gate and every consumer
   * inherits it.
   */
  // The WHOLE value, query included — everything this module emits is properly encoded, so there is
  // no legitimate return target with a broken escape anywhere in it.
  return isDecodable(value);
}

/** Whether `value` survives percent-decoding. `decodeURIComponent` throws rather than returning. */
function isDecodable(value: string): boolean {
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The label for a return link.
 *
 * DERIVED FROM THE PATH WHEREVER IT CAN BE, and a supplied `label` is honoured for exactly one case:
 * an organisation, whose display name is not derivable from its slug. That keeps the amount of
 * attacker-controlled text on screen to a minimum — a misleading label over an allowlisted internal
 * destination is a small problem, but it is not zero, and there is no reason to accept it anywhere
 * the path already says what the place is.
 *
 * It is still rendered as a text node like every other untrusted string in this package.
 */
export function returnLabel(value: string, label?: string | null): string {
  const [pathname = "", rawQuery = ""] = value.split("?");
  const query = new URLSearchParams(rawQuery);

  if (pathname.startsWith("/organisations/")) {
    const supplied = label?.trim();
    if (supplied) return supplied.slice(0, MAX_LABEL);
    const raw = pathname.slice("/organisations/".length);
    // Belt and braces: `isSafeReturnPath` already rejects an undecodable path, but this function is
    // exported and a throw here would be a render-time crash rather than a missing link.
    return isDecodable(raw) ? decodeURIComponent(raw) : raw;
  }
  if (pathname === "/organisations") return "your organisations";
  if (pathname.startsWith("/review")) {
    const tab = query.get("tab");
    if (tab === "organisations") return "organisations";
    if (tab === "claims") return "the claims queue";
    if (tab === "duplicates") return "the duplicate queue";
    return "the review queue";
  }
  if (pathname.startsWith("/duplicates")) return "possible duplicates";
  return "your listings";
}

export interface ReturnLink {
  /** An internal path, already validated. Safe to hand to `next/link`. */
  href: string;
  label: string;
}

/**
 * Read a return link off a detail page's own query string, or `null` when there is not a usable one.
 *
 * Everything unusable collapses to `null` — absent, external, malformed, off-allowlist — because a
 * reader cannot act on any of those and the page reads perfectly well without the link.
 */
export function parseReturnLink(
  back: string | null | undefined,
  label?: string | null,
): ReturnLink | null {
  if (!back || !isSafeReturnPath(back)) return null;
  return { href: back, label: returnLabel(back, label) };
}

/**
 * The query string an ORIGIN appends to a detail link so the detail page can offer the way back.
 *
 * Takes the origin's own path INCLUDING its query, because that state — which tab, which page, which
 * filter — is what makes the return land on the screen the reader actually left.
 */
export function returnParams(from: string, label?: string | null): string {
  if (!isSafeReturnPath(from)) return "";
  const params = new URLSearchParams({ [RETURN_PARAM]: from });
  // Only ever sent for an organisation, matching what `returnLabel` will consent to read back.
  if (label && from.startsWith("/organisations/")) {
    params.set(RETURN_LABEL_PARAM, label.slice(0, MAX_LABEL));
  }
  return params.toString();
}

/** A detail-page href for `id`, carrying the way back to `from`. */
export function detailHref(base: string, id: string, from: string, label?: string | null): string {
  const query = returnParams(from, label);
  const path = `${base}/${encodeURIComponent(id)}`;
  return query === "" ? path : `${path}?${query}`;
}
