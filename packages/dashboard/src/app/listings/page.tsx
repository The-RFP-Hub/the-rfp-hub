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
import type { ReviewStatus } from "@/lib/types";
import Link from "next/link";
import { useCallback, useState } from "react";

const FILTERS: { value: ReviewStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export default function ListingsPage() {
  return <RequireSession>{() => <Listings />}</RequireSession>;
}

function Listings() {
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

  return (
    <section>
      <div className="row-between">
        <h1>Your listings</h1>
        <Link href="/listings/new">
          <button type="button">Submit an entry</button>
        </Link>
      </div>

      {duplicates.state.status === "ready" && duplicates.state.data.items.length > 0 ? (
        <p className="note">
          <Link href="/duplicates">
            {duplicates.state.data.items.length} possible duplicate
            {duplicates.state.data.items.length === 1 ? "" : "s"} touch your entries
          </Link>{" "}
          <span className="muted">
            — counted across all of them; the API reports the other side of each pair, not which of
            yours it was matched against.
          </span>
        </p>
      ) : null}

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
              title="No entries here."
              detail={
                filter === "all"
                  ? "Nothing has been submitted under this account yet."
                  : `No entries with review status ${filter}.`
              }
            />
          ) : (
            <>
              <table>
                <caption>
                  {list.total} entr{list.total === 1 ? "y" : "ies"} · page {list.page} of{" "}
                  {list.totalPages}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Entry</th>
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
