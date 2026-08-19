"use client";

/**
 * Everything this account submitted or publishes, whatever its review status.
 *
 * This is the one list that shows PENDING and REJECTED entries: the public reads 404 them by
 * design, and `GET /v1/me/opportunities` exists so their owner can still see them.
 *
 * THE VERIFICATION BADGE IS FETCHED PER ROW, and that is a considered trade rather than an
 * oversight. The list payload carries review state but not the last verification run, so the only
 * alternatives were to drop the column or to widen the API. A page holds at most 20 rows, each
 * badge is one small GET that fails soft, and a "not checked yet" 404 is a real answer rather than
 * an error. If the column earns its place, the right fix is a field on the list row — recorded in
 * the README rather than pretended away.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { ListedBadge, MatchBadge, ReviewStatusBadge } from "@/components/badges";
import { EmptyState, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { ManagedOpportunity, Me, ReviewStatus } from "@/lib/types";
import Link from "next/link";
import { useCallback, useState } from "react";

const FILTERS: { value: ReviewStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export default function ListingsPage() {
  return <RequireSession>{(me) => <Listings me={me} />}</RequireSession>;
}

/**
 * How many submissions an account may have in review at once, when it holds no verified membership.
 *
 * THIS MIRRORS THE DEFAULT OF THE API'S `SUBMISSION_PENDING_LIMIT`, and mirrors are allowed to drift:
 * a deployment that sets that variable to something else makes this denominator wrong. It is used
 * only to PHRASE the warning and never to gate anything — the submit button is never disabled from
 * here, and the API's 409 `pending_limit_reached` is the only thing that decides, carrying its own
 * sentence with the real number in it (surfaced verbatim by the form). So the worst case is a
 * denominator that reads oddly for one release, not a submission wrongly refused or wrongly allowed.
 *
 * The one shape that would look broken rather than merely stale — "7 of 5" — is unreachable: past
 * the mirrored limit the banner drops the denominator instead of printing a contradiction.
 */
const PENDING_LIMIT = 5;
/** Below this the count is not worth mentioning; above it, running out stops being hypothetical. */
const PENDING_WARN_AT = 3;

function Listings({ me }: { me: Me }) {
  const api = useApi();
  const [filter, setFilter] = useState<ReviewStatus | "all">("all");
  const [page, setPage] = useState(1);

  const load = useCallback(
    () =>
      api.me.opportunities({
        reviewStatus: filter === "all" ? undefined : filter,
        page,
        limit: 20,
      }),
    [api, filter, page],
  );
  const { state, reload } = useResource(load);

  const loadDuplicates = useCallback(() => api.me.duplicates(), [api]);
  const duplicates = useResource(loadDuplicates);

  /*
   * THE SLOT COUNT IS ITS OWN READ, and a deliberately tiny one.
   *
   * It has to be the count of PENDING submissions whatever the reader is currently filtering by, so
   * it cannot come from the table above — that list is filtered, paginated, and usually showing
   * something else. `limit: 1` because only `total` is wanted.
   *
   * Skipped entirely for an account with a verified membership anywhere, because the API exempts
   * those from the cap: showing somebody a limit that does not apply to them is worse than showing
   * nothing.
   */
  const capped = !me.memberships.some((membership) => membership.verified);
  const loadPending = useCallback(
    () => api.me.opportunities({ reviewStatus: "pending", limit: 1 }),
    [api],
  );
  const pending = useResource(loadPending, { enabled: capped });
  const pendingTotal = pending.state.status === "ready" ? pending.state.data.total : null;

  return (
    <section>
      <div className="row-between">
        <h1>Your listings</h1>
        <Link className="button-primary" href="/listings/new">
          Submit an opportunity
        </Link>
      </div>

      {capped && pendingTotal !== null && pendingTotal >= PENDING_WARN_AT ? (
        <p className="note">
          <strong>
            {pendingTotal > PENDING_LIMIT
              ? `${pendingTotal} submissions in review.`
              : `${pendingTotal} of ${PENDING_LIMIT} submission slots in review.`}
          </strong>{" "}
          <span className="muted">
            {pendingTotal >= PENDING_LIMIT
              ? "You may not be able to submit another until one of them is decided — a slot frees as soon as a reviewer approves or refuses one, and the API says so exactly if you try."
              : "A slot frees as soon as a reviewer approves or refuses one. The limit applies to accounts without a verified publisher membership."}
          </span>
        </p>
      ) : null}

      {/*
       * DUPLICATES LIVE HERE NOW, not in the top-level navigation.
       *
       * It was a seventh destination competing with Dashboard and Listings, and it is not one: it
       * is a view OF your listings, empty most of the time, and belonged next to them. Which means
       * this page owes it a permanent way in — a link that appears only when there is something to
       * report is a page that cannot be reached to confirm there is nothing, and a reader who
       * remembers seeing the queue yesterday has no way back to it today.
       */}
      {duplicates.state.status === "ready" && duplicates.state.data.items.length > 0 ? (
        <p className="note">
          <Link href="/duplicates">
            {duplicates.state.data.items.length} possible duplicate
            {duplicates.state.data.items.length === 1 ? "" : "s"} touch your listings
          </Link>{" "}
          <span className="muted">
            — counted across all of them; the API reports the other side of each pair, not which of
            yours it was matched against.
          </span>
        </p>
      ) : (
        <p className="muted footnote">
          <Link href="/duplicates">Possible duplicates</Link>
          {/*
           * The reassuring half of that sentence is only said once the read has actually come
           * back. "Nothing has been flagged" printed over a request that is still in flight — or
           * one that failed — is the page inventing an answer it does not have.
           */}
          {duplicates.state.status === "ready"
            ? " — nothing of yours has been flagged as similar to another published listing."
            : null}
        </p>
      )}

      <fieldset className="segmented">
        <legend className="visually-hidden">Review status</legend>
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => {
              setFilter(option.value);
              setPage(1);
            }}
          >
            {option.label}
          </button>
        ))}
      </fieldset>

      <ResourceView resource={state} what="your listings" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title={filter === "all" ? "You have not submitted anything yet." : "Nothing here."}
              detail={
                filter === "all"
                  ? "Everything you submit shows up on this page — published or not — and stays visible to you while a reviewer looks at it."
                  : `No listings with review status ${filter}. Other statuses may still have some.`
              }
              action={
                filter === "all" ? (
                  <Link className="button-primary" href="/listings/new">
                    Submit an opportunity
                  </Link>
                ) : (
                  <button type="button" onClick={() => setFilter("all")}>
                    Show every status
                  </button>
                )
              }
            />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <caption>
                    {list.total} listing{list.total === 1 ? "" : "s"} · page {list.page} of{" "}
                    {list.totalPages}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Listing</th>
                      <th scope="col">State</th>
                      <th scope="col">Source link</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((item) => (
                      <tr key={item.id}>
                        <th scope="row">
                          <Link href={`/listings/${encodeURIComponent(item.id)}`}>
                            <UntrustedText value={item.title} />
                          </Link>
                          <div className="muted">
                            <code>{item.id}</code> · {item.fundingType} · {item.status}
                            {item.namespace ? (
                              <>
                                {" "}
                                · published as <UntrustedText value={item.namespace} />
                              </>
                            ) : null}
                          </div>
                          <Outcome item={item} />
                        </th>
                        <td>
                          <ReviewStatusBadge status={item.reviewStatus} />{" "}
                          <ListedBadge isListed={item.isListed} />
                        </td>
                        <td>
                          <VerificationCell id={item.id} />
                        </td>
                        <td className="muted">{formatInstant(item.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row">
                <button
                  type="button"
                  disabled={list.page <= 1}
                  onClick={() => setPage(list.page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={list.page >= list.totalPages}
                  onClick={() => setPage(list.page + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )
        }
      </ResourceView>
    </section>
  );
}

/**
 * WHAT HAPPENED TO THIS SUBMISSION, AND WHAT TO DO ABOUT IT.
 *
 * A REFUSAL WITHOUT ITS REASON IS THE WORST STATE THIS PRODUCT HAD. The listing was findable, the
 * word `rejected` was on it, and nothing said why — so the only way to learn was to ask a reviewer
 * who had already written the answer down. `lastDecision` carries that sentence now, and this is
 * where a submitter reads it, next to the thing it is about rather than three clicks away.
 *
 * PENDING SAYS WHAT IS HAPPENING TOO. "Pending" is a badge, not an explanation, and a first-time
 * submitter has no way to know whether it means "queued" or "something is wrong with it".
 *
 * `verified_publisher_namespace` is the token the API writes when a listing auto-published because
 * its namespace is verified. It is machine text, not prose, and is the one reason value that means
 * "no human wrote this" — so it is said in words rather than printed raw.
 */
function Outcome({ item }: { item: ManagedOpportunity }) {
  const decision = item.lastDecision;

  if (item.reviewStatus === "rejected") {
    return (
      <div className="cell-note">
        <strong>Not published.</strong>{" "}
        {decision?.reason && decision.reason !== "verified_publisher_namespace" ? (
          <>
            Reviewer&rsquo;s reason: <UntrustedText value={decision.reason} />
          </>
        ) : (
          <span className="muted">No reason was recorded with the decision.</span>
        )}
        <div className="muted">
          Editing it and saving resubmits it for review.{" "}
          <Link href={`/listings/${encodeURIComponent(item.id)}/edit`}>Fix and resubmit</Link>, or
          ask a reviewer if the reason is not clear.
        </div>
      </div>
    );
  }

  if (item.reviewStatus === "pending") {
    return (
      <div className="cell-note muted">
        Waiting for a reviewer. It is stored and nothing is wrong with it — it is not in the public
        directory until somebody approves it, and you will see the reason here if it is refused.
      </div>
    );
  }

  if (decision?.reason === "verified_publisher_namespace") {
    return (
      <div className="cell-note muted">
        Published without review — your organisation is a verified publisher in this namespace.
      </div>
    );
  }

  return null;
}

/**
 * The last verification run for one row.
 *
 * A 404 here means "never checked", which the API says in so many words, so it is rendered as that
 * rather than as a failure. Any other error is rendered as a dash: a column that cannot load must
 * not turn a whole page of listings into an error state.
 */
function VerificationCell({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.verification(id), [api, id]);
  const { state } = useResource(load);

  if (state.status === "idle" || state.status === "loading") {
    return <span className="muted">…</span>;
  }
  if (state.status === "error") {
    const notChecked = state.error instanceof ApiError && state.error.isNotFound;
    return notChecked ? <MatchBadge matched={null} /> : <span className="muted">—</span>;
  }
  return <MatchBadge matched={state.data.matched} />;
}
