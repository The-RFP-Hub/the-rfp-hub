/**
 * Editorial state, shown as a WORD and a SHAPE, never as a hue.
 *
 * Every badge here is grounded in server state — review status, listing, organization verification,
 * and the publisher's own `status`. The publisher-facing listing badge is the one deterministic
 * projection over those server axes.
 *
 * THE FOUR SHAPES ARE THE VOCABULARY, and they are defined once in the stylesheet rather than
 * per-badge: filled ink is live, a quiet outline is finished or terminal, a dashed outline is
 * provisional and waiting on somebody, and struck-through muted text is refused. A
 * reader who sees no colour at all, a printout, and a screenshot in a bug report all carry exactly
 * the same information as the screen does. That is the point of doing it this way rather than with
 * a green tick and a red cross.
 *
 * THE TOOLTIP IS NEVER THE ONLY EXPLANATION where the badge is load-bearing. A `title` does not
 * exist on a touch device and is not reliably announced; where a badge decides what happens to
 * somebody's work — the account page's organization table above all — `gloss` puts the sentence on
 * screen beside it and the tooltip stays as the longer form.
 */
import {
  PUBLISHER_STATUS_LABELS,
  type PublisherStatusSource,
  opportunityStatusLabel,
  publisherStatus,
  reviewStatusLabel,
} from "@/lib/presentation";

/** The one state a publisher needs to understand whether a listing is public and what happens next. */
export function PublisherStatusBadge({ source }: { source: PublisherStatusSource }) {
  const status = publisherStatus(source);
  const explanation = {
    merged: "Merged into another listing; this record is terminal",
    rejected: "Rejected by a Hub reviewer and not visible in the public directory",
    pending: "Stored and waiting for a Hub reviewer",
    hidden: "Approved, but hidden from the public directory",
    live: "Approved and visible in the public directory",
  }[status];
  return (
    <span className={`badge badge-${status}`} title={explanation}>
      {PUBLISHER_STATUS_LABELS[status]}
    </span>
  );
}

export function ReviewStatusBadge({ status }: { status: string }) {
  const explanation =
    status === "pending"
      ? "Stored and hidden from the public directory until a Hub reviewer approves it"
      : status === "approved"
        ? "Approved by a reviewer, or auto-approved for a verified namespace"
        : status === "rejected"
          ? "Rejected — not published"
          : status;
  return (
    <span className={`badge badge-${status}`} title={explanation}>
      {reviewStatusLabel(status)}
    </span>
  );
}

/**
 * The publisher's own lifecycle status, as the directory column reads it.
 *
 * It is a DIFFERENT AXIS from review status and the two are routinely confused: `open` is a
 * statement about whether the program is taking applications, `approved` is a statement about
 * whether the Hub has published the listing. A closed listing is still published; a pending listing
 * may well be open. Rendering them with the same vocabulary of shapes and never merging them into
 * one column is what keeps that distinction visible.
 */
export function StatusBadge({ status }: { status: string }) {
  const explanation =
    status === "open"
      ? "Taking applications now, as the publisher stated it"
      : status === "upcoming"
        ? "Announced, not yet taking applications"
        : status === "closed"
          ? "No longer taking applications"
          : status === "archived"
            ? "Kept for the record; the program is over"
            : status;
  return (
    <span className={`badge badge-${status}`} title={explanation}>
      {opportunityStatusLabel(status)}
    </span>
  );
}

/**
 * Listing is a separate axis from approval: an approved entry can be unlisted, and then it is not
 * in the public reads either. Showing only the review status would misreport that.
 */
export function ListedBadge({
  isListed,
  reviewStatus,
}: {
  isListed: boolean;
  reviewStatus: string;
}) {
  const visible = reviewStatus === "approved" && isListed;
  const label = visible
    ? "Visible in the public directory"
    : reviewStatus === "pending" && isListed
      ? "Will appear once approved"
      : reviewStatus === "approved"
        ? "Hidden from the public directory"
        : isListed
          ? "Listing preference: public"
          : "Listing preference: hidden";
  const explanation = visible
    ? "Approved and visible in the public directory"
    : reviewStatus === "pending" && isListed
      ? "Hidden while it waits for review; it will appear in the public directory once approved"
      : reviewStatus === "approved"
        ? "Approved, but hidden from the public directory"
        : isListed
          ? "The listing preference is public, but this listing is hidden because it is not approved"
          : "The listing preference is hidden; approval will not make it public";
  return (
    <span
      className={
        visible ? "badge badge-listed" : isListed ? "badge badge-pending" : "badge badge-unlisted"
      }
      title={explanation}
    >
      {label}
    </span>
  );
}

/** A merge is a terminal editorial state, so it uses the badge system's quiet outline. */
export function MergedBadge() {
  return (
    <span
      className="badge badge-merged"
      title="Merged into another listing; this record is terminal"
    >
      Merged
    </span>
  );
}

/**
 * Organization verification, which is what auto-approval hangs off: writes from a verified
 * namespace publish immediately, writes from an unverified one land pending.
 *
 * `gloss` puts that consequence on screen. "Verified" on its own reads as a vanity tick, and the
 * one place a member most needs to know what it actually means for them — their own account page —
 * is the one place a hover tooltip is least likely to be found.
 */
export function VerifiedBadge({ verified, gloss }: { verified: boolean; gloss?: boolean }) {
  const explanation = verified
    ? "Verified organization — its members' listings publish without review"
    : "Not verified — listings published under this organization prefix wait for review";
  const badge = (
    <span
      className={verified ? "badge badge-verified" : "badge badge-unverified"}
      title={explanation}
    >
      {verified ? "Verified" : "Not verified"}
    </span>
  );
  if (!gloss) return badge;
  return (
    <span className="badge-labelled">
      {badge}
      <span className="badge-gloss">
        {verified
          ? "your listings in this namespace publish immediately"
          : "your listings in this namespace wait for a reviewer"}
      </span>
    </span>
  );
}

/**
 * The verification-assist verdict on a listing's `applicationUrl`.
 *
 * `matched` is a LOW-BAR anti-spam signal — the page exists and its title is about the same
 * program — and never a fact-check. The title text says that, because a tick that reads as
 * "these details are correct" would be the single most misleading thing on this frontend.
 */
export function MatchBadge({
  matched,
  existsAtSource,
}: {
  matched: boolean | null;
  existsAtSource?: boolean | null;
}) {
  if (matched === null) {
    return (
      <span className="badge badge-unknown" title="This listing's link has not been checked yet">
        not checked
      </span>
    );
  }
  const failedLabel =
    existsAtSource === false
      ? "link not reachable"
      : existsAtSource === true
        ? "content did not match"
        : "link check failed";
  const failedTitle =
    existsAtSource === false
      ? "The application link could not be reached"
      : existsAtSource === true
        ? "The linked page was reached, but its title does not look like this program"
        : "The link check failed; no more specific result is available";
  return (
    <span
      className={matched ? "badge badge-matched" : "badge badge-unmatched"}
      title={
        matched
          ? "The linked page exists and its title is about this program. A low-bar anti-spam signal, not a fact-check."
          : failedTitle
      }
    >
      {matched ? "link looks right" : failedLabel}
    </span>
  );
}
