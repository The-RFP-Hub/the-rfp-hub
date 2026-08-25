"use client";

/**
 * One entry: what it says, and the four things the API can tell you about it.
 *
 * The record never comes from the public detail route: that one 404s a pending or rejected entry,
 * and a pending entry is exactly the thing the two audiences for this page need to look at. Those
 * audiences read it through different routes — the owner through `/v1/me/opportunities/{id}`, a
 * reviewer who owns nothing here through `/v1/review/opportunities/{id}` — and `loadOpportunity`
 * is the one place that picks between them.
 *
 * Every outbound link goes through the API's redirect routes. Linking straight to the stored URL
 * would leave the apply and source counters at zero and make the Analytics tab quietly wrong.
 */
import { AnalyticsTab } from "@/components/AnalyticsTab";
import { RequireSession } from "@/components/Chrome";
import { MergedOpportunityBanner } from "@/components/MergedOpportunityBanner";
import { ReturnLink } from "@/components/ReturnLink";
import { UntrustedBlock, UntrustedLink, UntrustedText } from "@/components/UntrustedText";
import { MatchBadge } from "@/components/badges";
import { ActionNote, EmptyState, ResourceView } from "@/components/states";
import { ApiError, linkOutUrl, loadManagedOpportunity, loadOpportunity } from "@/lib/api";
import { formatInstant, formatSimilarity } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { ManagedOpportunity, Me, Opportunity } from "@/lib/types";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";

const TABS = ["analytics", "audit", "verification", "duplicates"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  analytics: "Analytics",
  audit: "Audit",
  verification: "Verification",
  duplicates: "Duplicates",
};

export default function ListingPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ""));
  return <RequireSession>{(me) => <Listing id={id} me={me} />}</RequireSession>;
}

function Listing({ id, me }: { id: string; me: Me }) {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("analytics");
  // Owner route first, reviewer route as the fallback — the entry a reviewer was linked to from
  // the queue, a claim or a duplicate pair is by definition not theirs. See `loadOpportunity`.
  const load = useCallback(() => loadOpportunity(api, id, me.canReview), [api, id, me.canReview]);
  const loadWithMetadata = useCallback(async () => {
    const [entry, managed] = await Promise.all([
      load(),
      loadManagedOpportunity(api, id, me.canReview),
    ]);
    return { entry, managed };
  }, [api, id, load, me.canReview]);
  const { state, reload } = useResource(loadWithMetadata);

  return (
    <section>
      {/* Renders only when a review surface sent the reader here and said where from. */}
      <ReturnLink />
      <ResourceView resource={state} what="this listing" onRetry={reload}>
        {({ entry, managed }) => (
          <>
            {managed.mergedInto ? (
              <MergedOpportunityBanner mergedInto={managed.mergedInto} />
            ) : null}
            <Header entry={entry} id={id} managed={managed} />
          </>
        )}
      </ResourceView>

      <div className="tabs" role="tablist" aria-label="Listing detail">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      {tab === "analytics" ? <AnalyticsTab opportunityId={id} /> : null}
      {tab === "audit" ? <AuditTab id={id} /> : null}
      {tab === "verification" ? <VerificationTab id={id} canTrigger={me.canReview} /> : null}
      {tab === "duplicates" ? <DuplicatesTab id={id} /> : null}
    </section>
  );
}

function Header({
  entry,
  id,
  managed,
}: {
  entry: Opportunity;
  id: string;
  managed: ManagedOpportunity;
}) {
  const api = useApi();
  const source = entry.source ?? {};
  return (
    <>
      <div className="row-between">
        <h1>
          <UntrustedText value={entry.title} />
        </h1>
        {managed.mergedInto ? null : (
          <Link href={`/listings/${encodeURIComponent(id)}/edit`}>
            <button type="button">Edit</button>
          </Link>
        )}
      </div>
      <p className="muted">
        <code>{entry.id}</code> · {entry.fundingType} · {entry.status}
        {source.publisher ? (
          <>
            {" "}
            · namespace <UntrustedText value={source.publisher} />
          </>
        ) : null}
        {source.submittedBy ? (
          <>
            {" "}
            · submitted by <UntrustedText value={source.submittedBy} />
          </>
        ) : null}
      </p>

      <div className="row">
        {entry.applicationUrl ? (
          <a href={linkOutUrl(api.baseUrl, id, "apply")} target="_blank" rel="noopener noreferrer">
            Open the application page
          </a>
        ) : null}
        {entry.website ? (
          <a href={linkOutUrl(api.baseUrl, id, "source")} target="_blank" rel="noopener noreferrer">
            Open the programme site
          </a>
        ) : null}
        <span className="muted">
          (both hops go through the API, which is what makes the click counters move)
        </span>
      </div>

      <UntrustedBlock value={entry.description} />
    </>
  );
}

function AuditTab({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.audit(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <section aria-labelledby="audit-heading">
      <h2 id="audit-heading">History</h2>
      <p className="muted footnote">
        Every mutation, append-only. As this listing&rsquo;s owner you see the full patch; a member
        of the public sees the same actions with field names only.
      </p>
      <ResourceView resource={state} what="the audit trail" onRetry={reload}>
        {(trail) =>
          trail.entries.length === 0 ? (
            <EmptyState title="No recorded changes." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Fields</th>
                  </tr>
                </thead>
                <tbody>
                  {trail.entries.map((entry) => (
                    <tr key={`${entry.at}-${entry.action}`}>
                      <td className="muted">{formatInstant(entry.at)}</td>
                      <td>{entry.action}</td>
                      <td>
                        <UntrustedText value={entry.actor} />{" "}
                        <span className="muted">({entry.actorKind})</span>
                      </td>
                      <td>
                        {entry.changedFields.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <code>{entry.changedFields.join(", ")}</code>
                        )}
                        {entry.patch ? (
                          <details>
                            <summary className="muted">patch</summary>
                            <pre className="untrusted-block">
                              {JSON.stringify(entry.patch, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                      </td>
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

function VerificationTab({ id, canTrigger }: { id: string; canTrigger: boolean }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.verification(id), [api, id]);
  const { state, reload } = useResource(load);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  const trigger = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.review.verifySource(id);
      setNote({ kind: "ok", message: "Checked. The run below is the result." });
      reload();
    } catch (error) {
      setNote({
        kind: "error",
        message: error instanceof ApiError ? error.message : "The check could not be run.",
      });
    } finally {
      setBusy(false);
    }
  };

  const neverChecked = state.status === "error" && state.error.isNotFound;

  return (
    <section aria-labelledby="verify-heading">
      <h2 id="verify-heading">Source verification</h2>
      <p className="muted footnote">
        The check fetches this listing&rsquo;s <code>applicationUrl</code> and records what the page
        said. A match is a <strong>low-bar anti-spam signal</strong> — the page exists and its title
        is about the same programme — and never a fact-check of the amounts or the deadlines.
      </p>

      {canTrigger ? (
        <p>
          <button type="button" onClick={() => void trigger()} disabled={busy}>
            {busy ? "Checking…" : "Run the check now"}
          </button>
          <ActionNote note={note} />
        </p>
      ) : null}

      {neverChecked ? (
        <EmptyState
          title="This listing has not been checked yet."
          detail="A submission with an application URL is queued for the nightly pass; a reviewer can also run it on demand."
        />
      ) : (
        <ResourceView resource={state} what="the verification run" onRetry={reload}>
          {(run) => (
            <div className="card">
              <p>
                <MatchBadge matched={run.matched} />{" "}
                <span className="muted">checked {formatInstant(run.runAt)}</span>
              </p>
              <dl className="grid-2">
                <div>
                  <dt>Requested</dt>
                  <dd>
                    <UntrustedLink href={run.requestedUrl} />
                  </dd>
                </div>
                <div>
                  <dt>Ended at</dt>
                  <dd>
                    <UntrustedLink href={run.finalUrl} />
                  </dd>
                </div>
                <div>
                  <dt>HTTP status</dt>
                  <dd>{run.httpStatus ?? "—"}</dd>
                </div>
                <div>
                  <dt>Page exists</dt>
                  <dd>
                    {run.existsAtSource === null ? "unknown" : run.existsAtSource ? "yes" : "no"}
                  </dd>
                </div>
              </dl>
              {run.error ? <p className="note error">{run.error}</p> : null}
              {run.fieldDiff ? (
                <details>
                  <summary>What the page said about each field</summary>
                  <pre className="untrusted-block">{JSON.stringify(run.fieldDiff, null, 2)}</pre>
                </details>
              ) : null}
              {run.snapshotSha256 ? (
                <p className="muted">
                  Snapshot digest <code>{run.snapshotSha256.slice(0, 16)}…</code> — the extracted
                  text is stored with the run; the original bytes are not.
                </p>
              ) : null}
            </div>
          )}
        </ResourceView>
      )}
    </section>
  );
}

function DuplicatesTab({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.duplicates(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <section aria-labelledby="dupes-heading">
      <h2 id="dupes-heading">Possible duplicates</h2>
      <p className="muted footnote">
        Detected by comparing this listing against <strong>published</strong> listings only, so
        nothing here reveals another account&rsquo;s pending work. An empty list means nothing
        similar was found <em>if</em> the check has run — a deployment with detection switched off
        has nothing to show either.
      </p>
      <ResourceView resource={state} what="possible duplicates" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No suspected duplicates recorded for this listing." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Other listing</th>
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
            </div>
          )
        }
      </ResourceView>
    </section>
  );
}
