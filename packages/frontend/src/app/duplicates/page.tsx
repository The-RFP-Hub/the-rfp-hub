"use client";

/**
 * Suspected duplicates against this account's listings.
 *
 * Each row names the account-owned side and the entitled counterpart. Public counterparts open in
 * the directory; an owner-visible non-public counterpart stays in the workbench.
 *
 * Nothing here is destructive. Merging is a reviewer's action, on `/review`.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { EmptyState, ResourceView } from "@/components/states";
import { formatInstant, formatSimilarity } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import Link from "next/link";
import { useCallback } from "react";

export default function DuplicatesPage() {
  return <RequireSession>{() => <Duplicates />}</RequireSession>;
}

function Duplicates() {
  const api = useApi();
  const load = useCallback(() => api.me.duplicates(), [api]);
  const { state, reload } = useResource(load);

  return (
    <section>
      <h1>Possible duplicates</h1>
      <p className="muted footnote">
        Each row names one of your listings and the listing it resembles. Similarity is a
        model&rsquo;s opinion about wording, not a judgement about the programmes; two genuinely
        different rounds of the same grant will look alike. A reviewer decides, and only a reviewer
        can merge.
      </p>
      <ResourceView resource={state} what="your duplicate queue" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="Nothing flagged."
              detail="Either nothing similar was found, or your listings have not been through detection yet — the API does not distinguish the two on this route, and neither will this page."
              action={
                <Link className="button-primary" href="/listings">
                  Your listings
                </Link>
              }
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Your listing</th>
                    <th scope="col">Matched against</th>
                    <th scope="col">Similarity</th>
                    <th scope="col">State</th>
                    <th scope="col">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((match) => (
                    <tr key={`${match.yourListing.id}-${match.id}-${match.detectedAt}`}>
                      <th scope="row">
                        <Link href={`/listings/${encodeURIComponent(match.yourListing.id)}`}>
                          <UntrustedText value={match.yourListing.title} />
                        </Link>
                        <div className="muted">
                          <code>{match.yourListing.id}</code>
                        </div>
                      </th>
                      <th scope="row">
                        <Link
                          href={`${match.isPublic ? "/opportunities" : "/listings"}/${encodeURIComponent(match.id)}`}
                        >
                          <UntrustedText value={match.title} />
                        </Link>
                        <div className="muted">
                          <code>{match.id}</code>
                        </div>
                      </th>
                      <td>{formatSimilarity(match.similarity)}</td>
                      <td>{match.status}</td>
                      <td className="muted">{formatInstant(match.detectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </section>
  );
}
