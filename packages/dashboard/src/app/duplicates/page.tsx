"use client";

/**
 * Suspected duplicates against this account's entries.
 *
 * WHAT THE API DOES AND DOES NOT TELL A SUBMITTER, said plainly on the page: the search runs over
 * PUBLISHED entries only, and each row names the OTHER side of a pair. That is deliberate — a
 * duplicate response that named pending entries would turn this screen into a way to read the
 * review queue — and it means this page cannot say which of your entries a match was against.
 * Saying so is better than implying a link the data does not carry.
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
        Each row is the <strong>other</strong> entry in a suspected pair — a published listing that
        looks like something you submitted. Similarity is a model&rsquo;s opinion about wording, not
        a judgement about the programmes; two genuinely different rounds of the same grant will look
        alike. A reviewer decides, and only a reviewer can merge.
      </p>
      <ResourceView resource={state} what="your duplicate queue" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="Nothing flagged."
              detail="Either nothing similar was found, or the entries have not been through detection yet — the API does not distinguish the two on this route, and neither will this page."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Matched against</th>
                  <th scope="col">Similarity</th>
                  <th scope="col">State</th>
                  <th scope="col">Detected</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((match) => (
                  <tr key={`${match.id}-${match.detectedAt}`}>
                    <th scope="row">
                      <Link href={`/listings/${encodeURIComponent(match.id)}`}>
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
          )
        }
      </ResourceView>
    </section>
  );
}
