/**
 * Why a pair was flagged, as LABELS — computed at read time, never stored.
 *
 * Two rules govern this file and both are disclosure decisions rather than style.
 *
 * 1. **Labels, never values.** `["overlap", "application_url"]`, not the URL, not the org slug,
 *    not the amount. A submitter's duplicate check runs over approved-and-listed entries, so the
 *    counterpart is public and nothing here is secret — but "public somewhere" is not the same as
 *    "returned in this response", and putting a counterpart's fields into a match payload is a
 *    disclosure decision nobody made. A label array is not.
 * 2. **Computed from the LIVE rows, never from a stored snapshot.** "These two share an
 *    application URL" is a fact about two rows at one instant, and it stops being true the moment
 *    either is edited. Storing it would leave the queue explaining a match with evidence that no
 *    longer exists. It was never part of the decision either — see `duplicate-signal.ts` for why
 *    structural signals are barred from the predicate.
 *
 * A pair written before `signal` existed has no recorded reasons, and that renders as an EMPTY
 * ARRAY: "no reasons recorded". Not an absent field, not a crash, and deliberately not a
 * structural-only list either — a legacy row's decision inputs are genuinely unknown, and
 * inventing labels for it from today's live rows would attribute reasoning to a rule that never
 * ran.
 */

/** The fields a structural label may be derived from. Nothing here is ever returned to a client. */
export interface ReasonSide {
  applicationUrl: string | null;
  operatingOrganizations: { slug?: string | null }[] | null;
}

/** The labels this function can produce, so a client can switch on them exhaustively. */
export type MatchReason = "lexical" | "overlap" | "application_url" | "operating_org";

/**
 * Comparison form for a URL: scheme, `www.`, a trailing slash and case are not identity.
 *
 * Query and fragment ARE kept — plenty of real programmes live at `…/apply?round=8`, and dropping
 * the query would call two rounds of the same programme the same page.
 */
function normalizeUrl(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not parseable as an absolute URL: compare the raw text, lowercased and de-slashed, rather
    // than declaring two unparseable strings different when they are character-identical.
    return value.toLowerCase().replace(/\/+$/, "");
  }
  const host = url.host.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}${url.search}`;
}

/**
 * The PRIMARY operating organization's slug — `operatingOrganizations[0]`, not `orgSlugs[0]`.
 *
 * `orgSlugs` is an unordered set maintained for the GIN index and carries no primacy; its first
 * element is whatever the array happened to be built in. `operatingOrganizations` is the
 * Standard's ordered array, where position 0 means something.
 */
function primaryOrgSlug(side: ReasonSide): string | null {
  const slug = side.operatingOrganizations?.[0]?.slug;
  const value = (slug ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

/**
 * The arm that decided, plus whatever structural evidence the two live rows happen to corroborate
 * it with.
 *
 * `signal` is the stored jsonb. It is read defensively — it is a `jsonb` column, so a row written
 * by a future or a hand-edited version of this code must degrade to "no reasons" rather than throw
 * inside a read path.
 */
export function matchReasons(
  signal: Record<string, unknown> | null | undefined,
  left: ReasonSide,
  right: ReasonSide,
): MatchReason[] {
  if (signal === null || signal === undefined) return [];
  const arm = signal.arm;
  if (arm !== "lexical" && arm !== "overlap") return [];

  const reasons: MatchReason[] = [arm];

  const leftUrl = normalizeUrl(left.applicationUrl);
  if (leftUrl !== null && leftUrl === normalizeUrl(right.applicationUrl)) {
    reasons.push("application_url");
  }

  const leftOrg = primaryOrgSlug(left);
  if (leftOrg !== null && leftOrg === primaryOrgSlug(right)) reasons.push("operating_org");

  return reasons;
}
