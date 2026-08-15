"use client";

/**
 * The reviewer surface: the pending queue, ownership claims, and the duplicate queue.
 *
 * Every action here is enforced on the API as a session-only reviewer capability — a reviewer's own
 * API key is refused. This page is the interface to those routes, never a second implementation of
 * them: it renders what the API answered, including its refusals.
 *
 * The destructive one is the merge, and it is treated as such: the survivor is chosen explicitly,
 * nothing is copied between the two entries by default, and a 409 that names a different survivor
 * is rendered as a link to that entry rather than as a dead end.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { ListedBadge, ReviewStatusBadge, VerifiedBadge } from "@/components/badges";
import { ActionNote, EmptyState, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant, formatSimilarity } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { DuplicatePair, DuplicateSide } from "@/lib/types";
import Link from "next/link";
import { useCallback, useState } from "react";

type Section = "queue" | "claims" | "duplicates" | "organizations";
const SECTIONS: { value: Section; label: string }[] = [
  { value: "queue", label: "Pending entries" },
  { value: "claims", label: "Claims" },
  { value: "duplicates", label: "Duplicates" },
  { value: "organizations", label: "Organisations" },
];

export default function ReviewPage() {
  const [section, setSection] = useState<Section>("queue");
  return (
    <RequireSession capability={{ needs: (me) => me.canReview, label: "the reviewer capability" }}>
      {() => (
        <section>
          <h1>Review</h1>
          <div className="tabs" role="tablist" aria-label="Review queues">
            {SECTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={section === item.value}
                aria-pressed={section === item.value}
                onClick={() => setSection(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {section === "queue" ? <Queue /> : null}
          {section === "claims" ? <Claims /> : null}
          {section === "duplicates" ? <Duplicates /> : null}
          {section === "organizations" ? <Organizations /> : null}
        </section>
      )}
    </RequireSession>
  );
}

function useAction() {
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ kind: "ok", message: await work() });
    } catch (error) {
      setNote({
        kind: "error",
        message:
          error instanceof ApiError ? `${error.message} (${error.code})` : "The action failed.",
      });
    } finally {
      setBusy(false);
    }
  };
  return { note, busy, run, setNote };
}

function Queue() {
  const api = useApi();
  const load = useCallback(
    () => api.review.opportunities({ reviewStatus: "pending", limit: 50 }),
    [api],
  );
  const { state, reload } = useResource(load);
  const { note, busy, run } = useAction();

  return (
    <>
      <p className="muted footnote">
        Approving publishes an entry into the public reads. Rejecting also unlists it. Neither is a
        statement about the programme&rsquo;s quality — it is a statement about whether the record
        is real and conformant.
      </p>
      <ActionNote note={note} />
      <ResourceView resource={state} what="the review queue" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="Nothing waiting for review." />
          ) : (
            <table>
              <caption>{list.total} pending</caption>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">Submitted by</th>
                  <th scope="col">State</th>
                  <th scope="col">Decision</th>
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
                        <code>{item.id}</code> · {item.fundingType} ·{" "}
                        {formatInstant(item.createdAt)}
                      </div>
                    </th>
                    <td>
                      <UntrustedText value={item.submittedBy} fallback="community" />
                      {item.namespace ? (
                        <div className="muted">
                          namespace <UntrustedText value={item.namespace} />
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <ReviewStatusBadge status={item.reviewStatus} />{" "}
                      <ListedBadge isListed={item.isListed} />
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.review.approve(item.id);
                              reload();
                              return `${item.id} approved.`;
                            })
                          }
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.review.reject(item.id);
                              reload();
                              return `${item.id} rejected and unlisted.`;
                            })
                          }
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const run_ = await api.review.verifySource(item.id);
                              return `Source check: ${
                                run_.matched === null
                                  ? "no verdict"
                                  : run_.matched
                                    ? "the linked page looks like this programme"
                                    : "the linked page did not match"
                              } (HTTP ${run_.httpStatus ?? "—"}).`;
                            })
                          }
                        >
                          Check source
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </>
  );
}

function Claims() {
  const api = useApi();
  const load = useCallback(() => api.review.claims({ status: "pending" }), [api]);
  const { state, reload } = useResource(load);
  const { note, busy, run } = useAction();

  return (
    <>
      <p className="muted footnote">
        Approving a claim transfers publisher ownership.{" "}
        <strong>Verifying the organisation is a separate decision</strong> and it is the one that
        unlocks auto-approval: approve without it and that publisher&rsquo;s future writes keep
        landing pending. The API returns a sentence saying which happened; it is shown verbatim.
      </p>
      <ActionNote note={note} />
      <ResourceView resource={state} what="the claim queue" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No claims waiting." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">Claimed for</th>
                  <th scope="col">Note</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((claim) => (
                  <tr key={claim.id}>
                    <th scope="row">
                      <Link href={`/listings/${encodeURIComponent(claim.opportunityId)}`}>
                        <UntrustedText value={claim.opportunityTitle} />
                      </Link>
                      <div className="muted">
                        <code>{claim.opportunityId}</code> · filed {formatInstant(claim.createdAt)}{" "}
                        by <UntrustedText value={claim.claimedBy} />
                      </div>
                    </th>
                    <td>
                      <UntrustedText value={claim.organizationSlug} />{" "}
                      <VerifiedBadge verified={claim.organizationVerified} />
                    </td>
                    <td>
                      <UntrustedText value={claim.note} />
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await api.review.approveClaim(claim.id, true);
                              reload();
                              return result.message;
                            })
                          }
                        >
                          Approve and verify the organisation
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await api.review.approveClaim(claim.id, false);
                              reload();
                              return result.message;
                            })
                          }
                        >
                          Approve without verifying
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await api.review.rejectClaim(claim.id);
                              reload();
                              return result.message;
                            })
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </>
  );
}

function Duplicates() {
  const api = useApi();
  const load = useCallback(() => api.review.duplicates({ status: "suspected", limit: 100 }), [api]);
  const { state, reload } = useResource(load);

  return (
    <>
      <p className="muted footnote">
        Both sides of every suspected pair, including entries that are pending or unlisted —
        deciding between two records is what a reviewer is for. Confirming and dismissing change the
        pair only. Merging is destructive: the loser is rejected, unlisted, archived and pointed at
        the survivor.
      </p>
      <ResourceView resource={state} what="the duplicate queue" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No suspected pairs." />
          ) : (
            <>
              {list.items.map((pair) => (
                <PairCard key={pair.id} pair={pair} onChanged={reload} />
              ))}
            </>
          )
        }
      </ResourceView>
    </>
  );
}

/**
 * Verifying an organisation, which is the single most consequential button on this page.
 *
 * It does not decorate a profile: every member of a verified organisation publishes into its
 * namespace WITHOUT REVIEW, from that moment on, and unverifying stops that immediately. The copy
 * says so next to the control rather than in a document nobody has open.
 */
function Organizations() {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const load = useCallback(
    () => api.review.organizations({ q: search || undefined, limit: 50 }),
    [api, search],
  );
  const { state, reload } = useResource(load);
  const { note, busy, run } = useAction();

  return (
    <>
      <p className="muted footnote">
        Verifying an organisation grants <strong>every one of its members</strong> the right to
        publish into its namespace without review, and it is what a claim approval needs in order to
        unlock auto-approval. Unverifying takes it away with immediate effect; entries already
        published stay published.
      </p>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <input
          aria-label="Search organisations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="name or slug"
        />
        <button type="submit">Search</button>
      </form>
      <ActionNote note={note} />
      <ResourceView resource={state} what="organisations" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No organisations matched." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Members</th>
                  <th scope="col">Publishing</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((org) => (
                  <tr key={org.slug}>
                    <th scope="row">
                      <UntrustedText value={org.name} />
                      <div className="muted">
                        <code>{org.slug}</code>
                      </div>
                    </th>
                    <td>{org.memberCount}</td>
                    <td>
                      <VerifiedBadge verified={org.verified} />
                      {org.verifiedAt ? (
                        <div className="muted">since {formatInstant(org.verifiedAt)}</div>
                      ) : null}
                    </td>
                    <td>
                      {org.verified ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.review.unverifyOrganization(org.slug);
                              reload();
                              return `${org.slug} is no longer verified — its members' writes land pending from now on.`;
                            })
                          }
                        >
                          Withdraw verification
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.review.verifyOrganization(org.slug);
                              reload();
                              return `${org.slug} is verified — its ${org.memberCount} member(s) now publish into that namespace without review.`;
                            })
                          }
                        >
                          Verify
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </>
  );
}

function PairCard({ pair, onChanged }: { pair: DuplicatePair; onChanged: () => void }) {
  const api = useApi();
  const { note, busy, run, setNote } = useAction();
  const [survivor, setSurvivor] = useState<string>(pair.left.id);
  const [survivorElsewhere, setSurvivorElsewhere] = useState<string | null>(null);

  const merge = () =>
    void (async () => {
      setSurvivorElsewhere(null);
      setNote(null);
      try {
        const result = await api.review.mergeDuplicate(pair.id, { survivorId: survivor });
        onChanged();
        setNote({
          kind: "ok",
          message: `Merged ${result.mergedId} into ${result.survivorId}. Copied fields: ${
            result.copiedFields.length === 0 ? "none" : result.copiedFields.join(", ")
          }.`,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "survivor_already_merged") {
          // The chosen survivor has itself already lost a merge. The API names the real one, so the
          // reviewer gets a link to it rather than a message telling them to go and find it.
          setSurvivorElsewhere(error.survivorId ?? null);
          setNote({ kind: "error", message: error.message });
          return;
        }
        setNote({
          kind: "error",
          message:
            error instanceof ApiError ? `${error.message} (${error.code})` : "The merge failed.",
        });
      }
    })();

  return (
    <div className="card">
      <div className="row-between">
        <strong>{formatSimilarity(pair.similarity)}</strong>
        <span className="muted">
          pair {pair.id} · {pair.status} · detected {formatInstant(pair.detectedAt)}
        </span>
      </div>
      <div className="grid-2">
        <Side
          side={pair.left}
          group={`survivor-${pair.id}`}
          selected={survivor === pair.left.id}
          onSelect={setSurvivor}
        />
        <Side
          side={pair.right}
          group={`survivor-${pair.id}`}
          selected={survivor === pair.right.id}
          onSelect={setSurvivor}
        />
      </div>
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.review.confirmDuplicate(pair.id);
              onChanged();
              return "Recorded as the same programme. Neither entry was touched.";
            })
          }
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.review.dismissDuplicate(pair.id);
              onChanged();
              return "Dismissed. Re-running detection will not resurrect this pair.";
            })
          }
        >
          Dismiss
        </button>
        <button type="button" disabled={busy} onClick={merge}>
          Merge, keeping <code>{survivor}</code>
        </button>
      </div>
      <ActionNote note={note} />
      {survivorElsewhere ? (
        <p className="note">
          That entry was already merged into{" "}
          <Link href={`/listings/${encodeURIComponent(survivorElsewhere)}`}>
            <code>{survivorElsewhere}</code>
          </Link>
          . Merge into that one instead — chains are refused so a survivor is always a single hop
          away.
        </p>
      ) : null}
    </div>
  );
}

function Side({
  side,
  group,
  selected,
  onSelect,
}: {
  side: DuplicateSide;
  /** Both sides of one pair share a radio group, or both could be chosen at once. */
  group: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <label className="row">
        <input
          type="radio"
          name={group}
          checked={selected}
          onChange={() => onSelect(side.id)}
          style={{ width: "auto" }}
        />
        <span>keep this one</span>
      </label>
      <p>
        <Link href={`/listings/${encodeURIComponent(side.id)}`}>
          <UntrustedText value={side.title} />
        </Link>
      </p>
      <p className="muted">
        <code>{side.id}</code>
        <br />
        <ReviewStatusBadge status={side.reviewStatus} /> <ListedBadge isListed={side.isListed} />
        {side.namespace ? (
          <>
            {" "}
            · <UntrustedText value={side.namespace} />
          </>
        ) : null}
        <br />
        updated {formatInstant(side.updatedAt)}
        {side.mergedInto ? (
          <>
            <br />
            already merged into <code>{side.mergedInto}</code>
          </>
        ) : null}
      </p>
    </div>
  );
}
