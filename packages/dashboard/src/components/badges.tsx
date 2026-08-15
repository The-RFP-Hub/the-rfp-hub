/**
 * Editorial state, shown as a word rather than only a colour.
 *
 * Every badge here reports SERVER state — review status, listing, organisation verification. None
 * of it is computed in the browser, and none of it is styled so that the colour is the only carrier
 * of the meaning.
 */

export function ReviewStatusBadge({ status }: { status: string }) {
  const explanation =
    status === "pending"
      ? "Stored, and invisible to the public reads until a reviewer approves it"
      : status === "approved"
        ? "Approved by a reviewer, or auto-approved for a verified namespace"
        : status === "rejected"
          ? "Rejected — not published"
          : status;
  return (
    <span className={`badge badge-${status}`} title={explanation}>
      {status}
    </span>
  );
}

/**
 * Listing is a separate axis from approval: an approved entry can be unlisted, and then it is not
 * in the public reads either. Showing only the review status would misreport that.
 */
export function ListedBadge({ isListed }: { isListed: boolean }) {
  return (
    <span
      className={isListed ? "badge badge-listed" : "badge badge-unlisted"}
      title={
        isListed
          ? "Included in the public list and detail reads"
          : "Withheld from the public reads, whatever its review status"
      }
    >
      {isListed ? "listed" : "unlisted"}
    </span>
  );
}

/**
 * Organisation verification, which is what auto-approval hangs off: writes from a verified
 * namespace publish immediately, writes from an unverified one land pending. The tooltip says so,
 * because "verified" on its own reads as a vanity tick.
 */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return (
    <span
      className={verified ? "badge badge-verified" : "badge badge-unverified"}
      title={
        verified
          ? "Verified organisation — its members' entries publish without review"
          : "Not verified — entries published under this namespace land pending"
      }
    >
      {verified ? "verified" : "unverified"}
    </span>
  );
}

/**
 * The verification-assist verdict on an entry's `applicationUrl`.
 *
 * `matched` is a LOW-BAR anti-spam signal — the page exists and its title is about the same
 * programme — and never a fact-check. The title text says that, because a green tick that reads as
 * "these details are correct" would be the single most misleading thing on this dashboard.
 */
export function MatchBadge({ matched }: { matched: boolean | null }) {
  if (matched === null) {
    return (
      <span className="badge badge-unknown" title="This entry's link has not been checked yet">
        not checked
      </span>
    );
  }
  return (
    <span
      className={matched ? "badge badge-matched" : "badge badge-unmatched"}
      title={
        matched
          ? "The linked page exists and its title is about this programme. A low-bar anti-spam signal, not a fact-check."
          : "The linked page did not resolve, or its title does not look like this programme"
      }
    >
      {matched ? "link looks right" : "link did not match"}
    </span>
  );
}
