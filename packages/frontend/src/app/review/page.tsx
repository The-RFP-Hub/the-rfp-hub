"use client";

/**
 * The reviewer surface: submissions, ownership claims, duplicates, and the organisations whose
 * verification decides who may publish without any of this.
 *
 * Every action here is enforced on the API as a session-only reviewer capability — a reviewer's own
 * API key is refused. This page is the interface to those routes, never a second implementation of
 * them: it renders what the API answered, including its refusals.
 *
 * THE COUNTS ARE LOADED ONCE, AT THE TOP, AND SHARED. A tab that says "Submissions · 7" has to know
 * the number before it is opened, so the three queues are read here and handed down rather than
 * fetched again inside each panel. It also means a decision in one tab updates the count on the
 * others, which is the behaviour a reviewer working through a backlog actually expects.
 *
 * THE TAB IS IN THE URL. A reviewer sends a colleague a link to the claim they are arguing about,
 * reloads after a decision, or presses Back — and every one of those used to land on Submissions.
 *
 * EVERY CONSEQUENTIAL BUTTON IS BEHIND A STATED CONSEQUENCE. Approving publishes somebody's listing
 * to the world; verifying an organisation grants publishing power to everyone in it, including
 * people added later; merging rejects and archives a record. None of them is undone by clicking
 * again, so none of them fires on the first click.
 */
import { RequireSession } from "@/components/Chrome";
import { ConfirmPanel } from "@/components/Confirm";
import { UntrustedBlock, UntrustedLink, UntrustedText } from "@/components/UntrustedText";
import { ListedBadge, ReviewStatusBadge, VerifiedBadge } from "@/components/badges";
import {
  ActionNote,
  type ActionNoteValue,
  EmptyState,
  ResourceView,
  actionErrorNote,
} from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant, formatSimilarity } from "@/lib/format";
import {
  CAPABILITY_DENIAL_COPY,
  ROUTE_GATE_COPY,
  accountRoleLabel,
  duplicateStatusLabel,
  fundingTypeLabel,
  opportunityStatusLabel,
  orgRoleLabel,
} from "@/lib/presentation";
import { type ResourceHandle, useResource } from "@/lib/resource";
import { detailHref } from "@/lib/return-to";
import { useApi } from "@/lib/session";
import type {
  AccountSummary,
  ClaimList,
  DuplicatePair,
  DuplicatePairList,
  DuplicateSide,
  ManagedOpportunity,
  ManagedOpportunityList,
  Me,
  Opportunity,
  OrgRole,
  OrganizationSummary,
} from "@/lib/types";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type Tab = "submissions" | "claims" | "duplicates" | "organisations";
const TABS: Tab[] = ["submissions", "claims", "duplicates", "organisations"];
const SUBMISSION_PAGE_SIZE = 50;
const LABELS: Record<Tab, string> = {
  submissions: "Submissions",
  claims: "Claims",
  duplicates: "Duplicates",
  organisations: "Organisations",
};

function submissionPageFromUrl(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) &&
    page > 1 &&
    (page - 1) * SUBMISSION_PAGE_SIZE <= Number.MAX_SAFE_INTEGER
    ? page
    : 1;
}

const submissionHref = (page: number): string => (page > 1 ? `/review?page=${page}` : "/review");

export default function ReviewPage() {
  return (
    <RequireSession
      gate={ROUTE_GATE_COPY.review}
      capability={{ needs: (me) => me.canReview, ...CAPABILITY_DENIAL_COPY.reviewer }}
    >
      {(me) => <Review me={me} />}
    </RequireSession>
  );
}

function Review({ me }: { me: Me }) {
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const requested = params?.get("tab");
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : "submissions";
  const [queuePage, setQueuePage] = useState(() => submissionPageFromUrl(params?.get("page")));

  const loadQueue = useCallback(
    () =>
      api.review.opportunities({
        reviewStatus: "pending",
        page: queuePage,
        limit: SUBMISSION_PAGE_SIZE,
      }),
    [api, queuePage],
  );
  const loadClaims = useCallback(() => api.review.claims({ status: "pending" }), [api]);
  const loadDuplicates = useCallback(async () => {
    const [suspected, confirmed] = await Promise.all([
      api.review.duplicates({ status: "suspected", limit: 200 }),
      api.review.duplicates({ status: "confirmed", limit: 200 }),
    ]);
    return { items: [...suspected.items, ...confirmed.items] } satisfies DuplicatePairList;
  }, [api]);

  const queue = useResource(loadQueue);
  const claims = useResource(loadClaims);
  const duplicates = useResource(loadDuplicates);

  useEffect(() => {
    if (queue.state.status !== "ready") return;
    if (queue.state.data.page > queue.state.data.totalPages) {
      const page = queue.state.data.totalPages;
      setQueuePage(page);
      router.replace(submissionHref(page));
    }
  }, [queue.state, router]);

  const counts: Record<Tab, number | null> = {
    submissions: queue.state.status === "ready" ? queue.state.data.total : null,
    claims: claims.state.status === "ready" ? claims.state.data.items.length : null,
    duplicates: duplicates.state.status === "ready" ? duplicates.state.data.items.length : null,
    organisations: null,
  };

  /**
   * The address for a tab, in ONE place.
   *
   * It is both what the tab switcher writes and what every link out of this page carries as its
   * return target, so the two cannot disagree: a reviewer who opens a listing from the claims tab
   * comes back to the claims tab rather than to Submissions.
   *
   * NOT NAMED `origin`. That is a DOM global (`window.origin`), so a local that fails to exist
   * silently resolves to `"http://localhost:3000"` instead of failing to compile — which is exactly
   * what happened here, and it typechecked perfectly while emitting no return parameter at all.
   */
  const tabHref = (next: Tab) =>
    next === "submissions" ? submissionHref(queuePage) : `/review?tab=${next}`;
  const returnHere = tabHref(tab);

  // `replace`, not `push`: switching tabs is not a navigation a reader wants to walk back through
  // one at a time, but the address still has to name where they are.
  const select = (next: Tab) => router.replace(tabHref(next));
  const selectQueuePage = (page: number) => {
    setQueuePage(page);
    router.replace(submissionHref(page));
  };

  return (
    <section>
      <h1>Review queues</h1>
      <div className="tabs" role="tablist" aria-label="Review queues">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-pressed={tab === item}
            onClick={() => select(item)}
          >
            {LABELS[item]}
            {counts[item] !== null ? ` · ${counts[item]}` : null}
          </button>
        ))}
      </div>

      {tab === "submissions" ? (
        <Submissions queue={queue} origin={returnHere} onPage={selectQueuePage} />
      ) : null}
      {tab === "claims" ? <Claims claims={claims} origin={returnHere} /> : null}
      {tab === "duplicates" ? <Duplicates duplicates={duplicates} origin={returnHere} /> : null}
      {tab === "organisations" ? <Organisations memberships={me.memberships} /> : null}
    </section>
  );
}

/** One action, its in-flight flag and whatever the API said about it. */
function useAction() {
  const [note, setNote] = useState<ActionNoteValue | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string | ActionNoteValue>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await work();
      setNote(typeof result === "string" ? { kind: "ok", message: result } : result);
    } catch (error) {
      setNote(actionErrorNote(error, "The action failed."));
    } finally {
      setBusy(false);
    }
  };
  return { note, busy, run, setNote };
}

// ── submissions ───────────────────────────────────────────────────────────────────

function Submissions({
  queue,
  origin,
  onPage,
}: {
  queue: ResourceHandle<ManagedOpportunityList>;
  origin: string;
  onPage: (page: number) => void;
}) {
  const { note, busy, run } = useAction();

  return (
    <>
      <p className="muted footnote">
        Approving publishes a listing into the public directory. Rejecting also unlists it. Neither
        is a statement about the programme&rsquo;s quality — it is a statement about whether the
        record is real and conformant.
      </p>
      <ActionNote note={note} />
      <ResourceView resource={queue.state} what="the submission queue" onRetry={queue.reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="Nothing waiting for review."
              detail="Submissions from accounts without a verified membership land here. An empty queue means every one of them has been decided."
            />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <caption>
                    {list.total} awaiting a decision
                    {list.total > list.items.length ? ` · showing ${list.items.length}` : null}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Listing</th>
                      <th scope="col">Submitted by</th>
                      <th scope="col">State</th>
                      <th scope="col">Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((item) => (
                      <SubmissionRow
                        key={item.id}
                        item={item}
                        busy={busy}
                        run={run}
                        reload={queue.reload}
                        origin={origin}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {list.totalPages > 1 ? (
                <nav className="pagination" aria-label="Submission queue pages">
                  <button
                    type="button"
                    disabled={list.page <= 1}
                    onClick={() => onPage(list.page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {list.page} of {list.totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={list.page >= list.totalPages}
                    onClick={() => onPage(list.page + 1)}
                  >
                    Next
                  </button>
                </nav>
              ) : null}
            </>
          )
        }
      </ResourceView>
    </>
  );
}

type SubmissionPanel = "none" | "details" | "approve" | "reject";

/**
 * One submission, with the things a decision actually needs behind an expander.
 *
 * WHY AN EXPANDER RATHER THAN A LINK. Deciding needs the summary, the link applicants would follow
 * and whether that link resolves; a reviewer working a queue of twenty was opening each one in a new
 * tab and coming back. The row keeps the queue in place and puts the evidence under it.
 */
function SubmissionRow({
  item,
  busy,
  run,
  reload,
  origin,
}: {
  item: ManagedOpportunity;
  busy: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
  reload: () => void;
  origin: string;
}) {
  const api = useApi();
  const [panel, setPanel] = useState<SubmissionPanel>("none");
  const [reason, setReason] = useState("");

  return (
    <>
      <tr>
        <th scope="row">
          <Link className="row-title" href={detailHref("/listings", item.id, origin)}>
            <UntrustedText value={item.title} />
          </Link>
          <div className="muted">
            <code>{item.id}</code> · {fundingTypeLabel(item.fundingType)} ·{" "}
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
          <ReviewStatusBadge status={item.reviewStatus} /> <ListedBadge isListed={item.isListed} />
        </td>
        <td>
          <div className="row">
            <button
              type="button"
              onClick={() => setPanel(panel === "approve" ? "none" : "approve")}
            >
              Approve…
            </button>
            <button type="button" onClick={() => setPanel(panel === "reject" ? "none" : "reject")}>
              Reject…
            </button>
            <button
              type="button"
              onClick={() => setPanel(panel === "details" ? "none" : "details")}
            >
              {panel === "details" ? "Hide details" : "Details"}
            </button>
          </div>
        </td>
      </tr>

      {panel !== "none" ? (
        <tr>
          <td colSpan={4}>
            {panel === "details" ? <SubmissionDetails item={item} origin={origin} /> : null}

            {panel === "approve" ? (
              <ConfirmPanel
                title="Publish this listing?"
                confirmLabel="Publish it"
                busyLabel="Publishing…"
                busy={busy}
                onCancel={() => setPanel("none")}
                onConfirm={() =>
                  void run(async () => {
                    await api.review.approve(item.id);
                    setPanel("none");
                    reload();
                    return `${item.id} is published.`;
                  })
                }
              >
                <p>
                  It becomes visible to everyone in the public directory and in the open-data
                  exports, immediately. Publishing is not an endorsement of the programme — it is a
                  statement that the record is real and conformant.
                </p>
              </ConfirmPanel>
            ) : null}

            {panel === "reject" ? (
              <ConfirmPanel
                title="Refuse this listing?"
                confirmLabel="Refuse it"
                busyLabel="Refusing…"
                busy={busy}
                disabled={reason.trim() === ""}
                onCancel={() => setPanel("none")}
                onConfirm={() =>
                  void run(async () => {
                    await api.review.reject(item.id, reason.trim());
                    setPanel("none");
                    setReason("");
                    reload();
                    return `${item.id} was refused and unlisted.`;
                  })
                }
              >
                <p>
                  It stays out of the public directory and is unlisted.{" "}
                  <strong>The reason is shown to whoever submitted it</strong> and is the only thing
                  that tells them what to fix — a refusal with no reason reads as the listing having
                  vanished.
                </p>
                <div className="field">
                  <label htmlFor={`review-reason-${item.id}`}>Reason</label>
                  <p className="hint">
                    Written for the submitter. What is wrong with the record, and what would make it
                    acceptable.
                  </p>
                  <input
                    id={`review-reason-${item.id}`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="e.g. the application link 404s and no other source names this programme"
                  />
                </div>
              </ConfirmPanel>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The evidence behind one row: what it says, where it points, and whether that link resolves.
 *
 * The source check is run ON DEMAND rather than on expand. It fetches a third-party URL, so firing
 * it every time a reviewer glanced at a row would make reading the queue an outbound crawl.
 */
function SubmissionDetails({ item, origin }: { item: ManagedOpportunity; origin: string }) {
  const api = useApi();
  /*
   * THE REVIEWER ROUTE, NOT THE PUBLIC ONE.
   *
   * This panel exists to show a PENDING submission's summary and application link, and the public
   * detail read 404s anything that is not `approved AND is_listed` — so it could never once have
   * loaded the thing it was built for. `/v1/review/opportunities/{id}` is entitled by the reviewer
   * ROLE rather than by ownership, which is exactly the credential everybody reading this page
   * holds.
   */
  const load = useCallback(() => api.review.opportunity(item.id), [api, item.id]);
  const { state } = useResource(load);
  const { note, busy, run } = useAction();

  return (
    <div className="card">
      <div className="table-scroll">
        <table>
          <tbody>
            <tr>
              <th scope="row">Submitted by</th>
              <td>
                <UntrustedText value={item.submittedBy} fallback="community" />
              </td>
            </tr>
            <tr>
              <th scope="row">Namespace</th>
              <td>
                <UntrustedText value={item.namespace} fallback="none — a community submission" />
              </td>
            </tr>
            <tr>
              <th scope="row">Last decision</th>
              <td>
                <LastDecision decision={item.lastDecision} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/*
       * Still degrades to a link rather than an alarm: a record can go away between the queue being
       * listed and a row being expanded, and a panel that shouts about it would be shouting about
       * somebody else having done their job.
       */}
      {state.status === "ready" ? (
        <>
          <p className="prose">
            <UntrustedText value={state.data.summary ?? state.data.description} />
          </p>
          <p className="muted">
            Application link:{" "}
            <UntrustedText value={state.data.applicationUrl} fallback="none given" />
          </p>
        </>
      ) : (
        <p className="muted footnote">
          The summary is on{" "}
          <Link href={detailHref("/listings", item.id, origin)}>the listing itself</Link> — a
          pending record is not served by the public read this panel uses.
        </p>
      )}

      <p className="row">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api.review.verifySource(item.id);
              const message = `Source check: ${
                result.matched === null
                  ? "no verdict"
                  : result.matched
                    ? "the linked page looks like this programme"
                    : "the linked page did not match"
              }. Source response: ${
                result.error
                  ? "check failed"
                  : result.existsAtSource === true
                    ? "page found"
                    : result.existsAtSource === false
                      ? "page not found"
                      : "no result"
              }.`;
              return {
                kind: "ok",
                message,
                technical: [
                  { label: "HTTP status", value: result.httpStatus ?? "—" },
                  ...(result.error ? [{ label: "Error", value: result.error }] : []),
                ],
              };
            })
          }
        >
          {busy ? "Checking…" : "Check the source link"}
        </button>
        <span className="muted footnote">
          Fetches the application URL and compares its title. A low-bar anti-spam signal, never a
          fact-check.
        </span>
      </p>
      <ActionNote note={note} />
    </div>
  );
}

/**
 * The newest decision on a listing.
 *
 * `verified_publisher_namespace` IS NOT PROSE. It is the token the API writes when a listing
 * auto-published because its namespace is verified, and showing it raw to a human — which is what
 * rendering `reason` verbatim would do — reads as a broken string. It is the one reason value that
 * means "no human wrote this", so it is said in words instead.
 */
function LastDecision({
  decision,
}: {
  decision: ManagedOpportunity["lastDecision"];
}) {
  if (!decision) return <span className="muted">none yet</span>;
  const auto = decision.reason === "verified_publisher_namespace";
  return (
    <>
      <strong>{decision.action === "approve" ? "approved" : "refused"}</strong>{" "}
      <span className="muted">{formatInstant(decision.at)}</span>
      {auto ? (
        <div className="muted">
          published automatically — its namespace is a verified publisher, so no reviewer saw it
        </div>
      ) : decision.reason ? (
        <div>
          <UntrustedText value={decision.reason} />
        </div>
      ) : (
        <div className="muted">no reason was recorded</div>
      )}
    </>
  );
}

// ── claims ────────────────────────────────────────────────────────────────────────

/**
 * Ownership claims, with the two approvals ranked rather than presented as a pair.
 *
 * THEY ARE NOT PEERS. Approving transfers ownership of one listing; approving AND verifying hands
 * the organisation permanent publishing rights over its whole namespace, for every member it has or
 * later gains. Two buttons side by side said those were comparable choices, and the more dangerous
 * one was the easier click because it came first.
 */
function Claims({ claims, origin }: { claims: ResourceHandle<ClaimList>; origin: string }) {
  const api = useApi();
  const { note, busy, run } = useAction();
  const [panel, setPanel] = useState<{ id: number; kind: "verify" | "reject" } | null>(null);
  const [reason, setReason] = useState("");

  return (
    <>
      <p className="muted footnote">
        Approving a claim transfers publisher ownership of that listing.{" "}
        <strong>Verifying the organisation is a separate and much larger decision</strong> — it is
        what unlocks auto-approval for everything that organisation publishes from then on. The API
        returns a sentence saying which happened; it is shown verbatim.
      </p>
      <ActionNote note={note} />
      <ResourceView resource={claims.state} what="the claim queue" onRetry={claims.reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="No claims waiting."
              detail="A claim is filed from a listing's own page by somebody who says it belongs to their organisation."
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Listing</th>
                    <th scope="col">Claimed for</th>
                    <th scope="col">Note</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((claim) => (
                    // A row and its confirmation panel are two `<tr>`s that belong to one claim, so
                    // the key goes on the fragment holding both rather than on either one.
                    <Fragment key={claim.id}>
                      <tr>
                        <th scope="row">
                          <Link
                            className="row-title"
                            href={detailHref("/listings", claim.opportunityId, origin)}
                          >
                            <UntrustedText value={claim.opportunityTitle} />
                          </Link>
                          <div className="muted">
                            <code>{claim.opportunityId}</code> · filed{" "}
                            {formatInstant(claim.createdAt)} by{" "}
                            <UntrustedText value={claim.claimedBy} />
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
                              className="button-primary"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const result = await api.review.approveClaim(claim.id, false);
                                  claims.reload();
                                  return result.message;
                                })
                              }
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setPanel(
                                  panel?.id === claim.id && panel.kind === "verify"
                                    ? null
                                    : { id: claim.id, kind: "verify" },
                                )
                              }
                            >
                              Approve and verify…
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setPanel(
                                  panel?.id === claim.id && panel.kind === "reject"
                                    ? null
                                    : { id: claim.id, kind: "reject" },
                                )
                              }
                            >
                              Reject…
                            </button>
                          </div>
                          <p className="faint footnote">
                            Approving alone transfers this listing; the organisation&rsquo;s future
                            writes still wait for review.
                          </p>
                        </td>
                      </tr>
                      {panel?.id === claim.id ? (
                        <tr>
                          <td colSpan={4}>
                            {panel.kind === "verify" ? (
                              <ConfirmPanel
                                title={`Approve the claim and verify ${claim.organizationSlug}?`}
                                confirmLabel="Approve and verify"
                                busyLabel="Approving…"
                                busy={busy}
                                onCancel={() => setPanel(null)}
                                onConfirm={() =>
                                  void run(async () => {
                                    const result = await api.review.approveClaim(claim.id, true);
                                    setPanel(null);
                                    claims.reload();
                                    return result.message;
                                  })
                                }
                              >
                                <p>
                                  Every member of{" "}
                                  <strong>
                                    <UntrustedText value={claim.organizationSlug} />
                                  </strong>{" "}
                                  — and every member added later — will publish anything into that
                                  namespace immediately and without review.{" "}
                                  <strong>
                                    This is not a badge; it is a grant of publishing power.
                                  </strong>{" "}
                                  Withdrawing it later stops future writes but already-published
                                  listings stay published.
                                </p>
                              </ConfirmPanel>
                            ) : (
                              <ConfirmPanel
                                title="Reject this claim?"
                                confirmLabel="Reject the claim"
                                busyLabel="Rejecting…"
                                busy={busy}
                                disabled={reason.trim() === ""}
                                onCancel={() => setPanel(null)}
                                onConfirm={() =>
                                  void run(async () => {
                                    const result = await api.review.rejectClaim(claim.id);
                                    setPanel(null);
                                    setReason("");
                                    claims.reload();
                                    return result.message;
                                  })
                                }
                              >
                                <p>
                                  Ownership stays where it is. The claimant is told the claim was
                                  refused.
                                </p>
                                <div className="field">
                                  <label htmlFor={`claim-reason-${claim.id}`}>
                                    Reason (for your own record)
                                  </label>
                                  <p className="hint">
                                    The claim API does not carry a reason today, so this is not sent
                                    — it is here to make you state one before refusing. Put it in
                                    the listing&rsquo;s audit trail if it matters.
                                  </p>
                                  <input
                                    id={`claim-reason-${claim.id}`}
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                  />
                                </div>
                              </ConfirmPanel>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}

// ── duplicates ────────────────────────────────────────────────────────────────────

function Duplicates({
  duplicates,
  origin,
}: { duplicates: ResourceHandle<DuplicatePairList>; origin: string }) {
  const [minimumSimilarity, setMinimumSimilarity] = useState(85);
  const [showBelowThreshold, setShowBelowThreshold] = useState(false);

  return (
    <>
      <p className="muted footnote">
        Both sides of every suspected pair, including listings that are pending or unlisted —
        deciding between two records is what a reviewer is for. Confirming and dismissing change the
        pair only. Merging is destructive.
      </p>
      <ResourceView
        resource={duplicates.state}
        what="the duplicate queue"
        onRetry={duplicates.reload}
      >
        {(list) => {
          const sorted = [...list.items].sort(
            (a, b) =>
              (b.similarity ?? Number.NEGATIVE_INFINITY) -
              (a.similarity ?? Number.NEGATIVE_INFINITY),
          );
          const shown = showBelowThreshold
            ? sorted
            : sorted.filter(
                (pair) => pair.similarity !== null && pair.similarity * 100 >= minimumSimilarity,
              );
          const hidden = sorted.length - shown.length;

          return list.items.length === 0 ? (
            <EmptyState
              title="No open pairs."
              detail="Detection runs against published listings when something is submitted. An empty queue means nothing recent looked like anything already published."
            />
          ) : (
            <>
              <div className="duplicate-filter">
                <label htmlFor="minimum-similarity">Minimum similarity</label>
                <input
                  id="minimum-similarity"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={minimumSimilarity}
                  onChange={(event) => {
                    setMinimumSimilarity(Number(event.target.value));
                    setShowBelowThreshold(false);
                  }}
                />
                <strong>{minimumSimilarity}%</strong>
              </div>
              <p className="muted footnote">
                {shown.length} of {sorted.length} open pairs loaded on this page.
                {hidden > 0 ? (
                  <>
                    {" "}
                    <button type="button" onClick={() => setShowBelowThreshold(true)}>
                      {hidden} below the threshold — show them
                    </button>
                  </>
                ) : null}
              </p>
              {shown.length === 0 ? (
                <EmptyState
                  title={`No loaded pairs meet ${minimumSimilarity}%.`}
                  detail="Lower the minimum similarity or show the pairs below the threshold."
                  action={
                    <button type="button" onClick={() => setShowBelowThreshold(true)}>
                      Show all loaded pairs
                    </button>
                  }
                />
              ) : null}
              {shown.map((pair) => (
                <PairCard key={pair.id} pair={pair} onChanged={duplicates.reload} origin={origin} />
              ))}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function PairCard({
  pair,
  onChanged,
  origin,
}: { pair: DuplicatePair; onChanged: () => void; origin: string }) {
  const api = useApi();
  const { note, busy, run, setNote } = useAction();
  const [survivor, setSurvivor] = useState<string>(pair.left.id);
  const [confirming, setConfirming] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [survivorElsewhere, setSurvivorElsewhere] = useState<string | null>(null);

  const loser = survivor === pair.left.id ? pair.right : pair.left;

  const merge = () =>
    void (async () => {
      setSurvivorElsewhere(null);
      setNote(null);
      try {
        const result = await api.review.mergeDuplicate(pair.id, { survivorId: survivor });
        setConfirming(false);
        onChanged();
        setNote({
          kind: "ok",
          message: `Merged ${result.mergedId} into ${result.survivorId}. Copied fields: ${
            result.copiedFields.length === 0 ? "none" : result.copiedFields.join(", ")
          }.`,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "survivor_already_merged") {
          setSurvivorElsewhere(error.survivorId ?? null);
          setNote(actionErrorNote(error, "The merge failed."));
          return;
        }
        setNote(actionErrorNote(error, "The merge failed."));
      }
    })();

  return (
    <div className="card">
      <div className="row-between">
        <strong>{formatSimilarity(pair.similarity)}</strong>
        <span className="muted">
          pair {pair.id} · {duplicateStatusLabel(pair.status)} · detected{" "}
          {formatInstant(pair.detectedAt)}
        </span>
      </div>
      <div className="grid-2">
        <Side
          side={pair.left}
          group={`survivor-${pair.id}`}
          selected={survivor === pair.left.id}
          onSelect={setSurvivor}
          origin={origin}
        />
        <Side
          side={pair.right}
          group={`survivor-${pair.id}`}
          selected={survivor === pair.right.id}
          onSelect={setSurvivor}
          origin={origin}
        />
      </div>
      <div className="row">
        <button type="button" onClick={() => setComparing((value) => !value)}>
          {comparing ? "Hide comparison" : "Compare descriptions"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.review.confirmDuplicate(pair.id);
              onChanged();
              return "Recorded as the same programme. Neither listing was touched.";
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
        <button type="button" disabled={busy} onClick={() => setConfirming(!confirming)}>
          Merge…
        </button>
      </div>

      {comparing ? <PairComparison pair={pair} /> : null}

      {confirming ? (
        <ConfirmPanel
          title="Merge these two listings?"
          confirmLabel="Merge them"
          busyLabel="Merging…"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={merge}
        >
          <p>
            <code>{survivor}</code> survives and stays as it is — nothing is copied into it unless
            you say so, and this screen does not offer to.
          </p>
          <p>
            <code>{loser.id}</code> —{" "}
            <strong>
              <UntrustedText value={loser.title} />
            </strong>{" "}
            — is <strong>rejected, unlisted, archived and pointed at the survivor</strong>. It
            leaves the public directory and its public link forwards to the survivor. This is not
            undone by merging the other way afterwards.
          </p>
        </ConfirmPanel>
      ) : null}

      <ActionNote note={note} />
      {survivorElsewhere ? (
        <p className="note">
          That listing was already merged into{" "}
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

function PairComparison({ pair }: { pair: DuplicatePair }) {
  const api = useApi();
  const load = useCallback(
    () =>
      Promise.all([api.review.opportunity(pair.left.id), api.review.opportunity(pair.right.id)]),
    [api, pair.left.id, pair.right.id],
  );
  const comparison = useResource(load);

  return (
    <section className="duplicate-comparison" aria-label={`Comparison for pair ${pair.id}`}>
      <ResourceView
        resource={comparison.state}
        what={`pair ${pair.id}'s descriptions`}
        onRetry={comparison.reload}
      >
        {([left, right]) => <ComparisonFields left={left} right={right} />}
      </ResourceView>
    </section>
  );
}

function ComparisonFields({ left, right }: { left: Opportunity; right: Opportunity }) {
  const fields = useMemo(
    () => [
      {
        label: "Title",
        left: <UntrustedText value={left.title} />,
        right: <UntrustedText value={right.title} />,
        differs: left.title !== right.title,
      },
      {
        label: "Funding type",
        left: fundingTypeLabel(left.fundingType),
        right: fundingTypeLabel(right.fundingType),
        differs: left.fundingType !== right.fundingType,
      },
      {
        label: "Application stage",
        left: opportunityStatusLabel(left.status),
        right: opportunityStatusLabel(right.status),
        differs: left.status !== right.status,
      },
      {
        label: "Summary",
        left: <UntrustedBlock value={left.summary} fallback="No summary was provided." />,
        right: <UntrustedBlock value={right.summary} fallback="No summary was provided." />,
        differs: (left.summary ?? "") !== (right.summary ?? ""),
      },
      {
        label: "Description",
        left: <UntrustedBlock value={left.description} />,
        right: <UntrustedBlock value={right.description} />,
        differs: left.description !== right.description,
      },
      {
        label: "Application URL",
        left: <UntrustedLink href={left.applicationUrl} />,
        right: <UntrustedLink href={right.applicationUrl} />,
        differs: (left.applicationUrl ?? "") !== (right.applicationUrl ?? ""),
      },
    ],
    [left, right],
  );

  return (
    <div className="duplicate-comparison-scroll">
      <div className="duplicate-comparison-grid">
        <div aria-hidden="true" />
        <h3>
          <UntrustedText value={left.title} />
        </h3>
        <h3>
          <UntrustedText value={right.title} />
        </h3>
        {fields.map((field) => (
          <ComparisonField key={field.label} {...field} />
        ))}
      </div>
    </div>
  );
}

function ComparisonField({
  label,
  left,
  right,
  differs,
}: { label: string; left: ReactNode; right: ReactNode; differs: boolean }) {
  return (
    <Fragment>
      <h4 className={differs ? "duplicate-comparison-difference" : undefined}>
        {label}
        {differs ? <span className="badge">Different</span> : null}
      </h4>
      <div className={differs ? "duplicate-comparison-difference" : undefined}>{left}</div>
      <div className={differs ? "duplicate-comparison-difference" : undefined}>{right}</div>
    </Fragment>
  );
}

function Side({
  side,
  group,
  selected,
  onSelect,
  origin,
}: {
  side: DuplicateSide;
  group: string;
  selected: boolean;
  onSelect: (id: string) => void;
  origin: string;
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
        <Link href={detailHref("/listings", side.id, origin)}>
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

// ── organisations ─────────────────────────────────────────────────────────────────

/**
 * Verifying an organisation, which is the single most consequential control in this application.
 *
 * IT IS SEARCH-FIRST, and that is a safety property rather than a layout preference. The directory
 * auto-registers a stub for every organisation any listing merely NAMES, so an unfiltered list is
 * hundreds of names nobody has ever vouched for, sorted alphabetically, with the one that matters
 * somewhere in the middle. Verifying the wrong row from a list like that grants publishing rights
 * over a namespace to whoever is added to it next.
 *
 * So the page shows what is already trusted or already peopled, and everything else is behind a
 * deliberate search.
 */
function Organisations({ memberships }: { memberships: Me["memberships"] }) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { note, busy, run } = useAction();

  const loadVerified = useCallback(
    () => api.review.organizations({ verified: true, limit: 100 }),
    [api],
  );
  const loadUnverified = useCallback(
    () => api.review.organizations({ verified: false, limit: 100 }),
    [api],
  );
  const loadSearch = useCallback(
    () => api.review.organizations({ q: search, limit: 100 }),
    [api, search],
  );

  const verified = useResource(loadVerified);
  const unverified = useResource(loadUnverified);
  const found = useResource(loadSearch, { enabled: search !== "" });

  const peopled =
    unverified.state.status === "ready"
      ? unverified.state.data.items.filter((org) => org.memberCount > 0)
      : [];
  const reloadAll = () => {
    verified.reload();
    unverified.reload();
    if (search !== "") found.reload();
  };

  return (
    <>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <input
          aria-label="Search organisations by name or slug"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search organisations by name or slug…"
        />
        <button type="submit" className="button-primary">
          Search
        </button>
        {search !== "" ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSearch("");
            }}
          >
            Clear
          </button>
        ) : null}
      </form>
      <p className="muted footnote">
        Verifying is not directory housekeeping — it grants publishing rights. The two lists below
        are the organisations that are already verified or already have members; every other name in
        the corpus is a stub auto-registered from a listing that mentioned it, and lives behind the
        search.
      </p>
      <ActionNote note={note} />

      <h2 className="section-head">
        Verified
        {verified.state.status === "ready" ? ` · ${verified.state.data.items.length}` : null}
      </h2>
      <ResourceView
        resource={verified.state}
        what="verified organisations"
        onRetry={verified.reload}
      >
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="No organisation is verified."
              detail="Nothing publishes without review until one is. Find an organisation with members below, or by searching."
            />
          ) : (
            <OrgTable
              orgs={list.items}
              memberships={memberships}
              busy={busy}
              run={run}
              reload={reloadAll}
            />
          )
        }
      </ResourceView>

      <h2 className="section-head">Has members, not verified{` · ${peopled.length}`}</h2>
      <ResourceView
        resource={unverified.state}
        what="unverified organisations"
        onRetry={unverified.reload}
      >
        {(list) =>
          peopled.length === 0 ? (
            <EmptyState
              title="No unverified organisation has members."
              detail="A membership is granted from an approved claim, or directly by a reviewer. Verifying an organisation with no members grants nothing today and arms whoever is added next."
            />
          ) : (
            <>
              <OrgTable
                orgs={peopled}
                memberships={memberships}
                busy={busy}
                run={run}
                reload={reloadAll}
              />
              {list.items.length >= 100 ? (
                <p className="muted footnote">
                  Showing the first 100 unverified organisations by slug. There are at least that
                  many, so this list may be incomplete — search for a specific one rather than
                  assuming it is absent.
                </p>
              ) : null}
            </>
          )
        }
      </ResourceView>

      {search !== "" ? (
        <>
          <h2 className="section-head section-head-quiet">From search: “{search}”</h2>
          <ResourceView resource={found.state} what="the search results" onRetry={found.reload}>
            {(list) =>
              list.items.length === 0 ? (
                <EmptyState
                  title="Nothing matched that."
                  detail="Names and slugs are both searched."
                />
              ) : (
                <OrgTable
                  orgs={list.items}
                  memberships={memberships}
                  busy={busy}
                  run={run}
                  reload={reloadAll}
                  showStubGuard
                />
              )
            }
          </ResourceView>
        </>
      ) : null}
    </>
  );
}

function OrgTable({
  orgs,
  memberships,
  busy,
  run,
  reload,
  showStubGuard,
}: {
  orgs: OrganizationSummary[];
  memberships: Me["memberships"];
  busy: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
  reload: () => void;
  /** Search results can contain stubs, which need the "grants nothing today" warning inline. */
  showStubGuard?: boolean;
}) {
  return (
    <div className="table-scroll">
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
          {orgs.map((org) => (
            <OrgRow
              key={org.slug}
              org={org}
              canOpen={memberships.some((membership) => membership.slug === org.slug)}
              busy={busy}
              run={run}
              reload={reload}
              showStubGuard={showStubGuard}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrgRow({
  org,
  canOpen,
  busy,
  run,
  reload,
  showStubGuard,
}: {
  org: OrganizationSummary;
  canOpen: boolean;
  busy: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
  reload: () => void;
  showStubGuard?: boolean;
}) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [granting, setGranting] = useState(false);
  const memberless = org.memberCount === 0;

  return (
    <>
      <tr>
        <th scope="row">
          {canOpen ? (
            <Link className="row-title" href={`/organisations/${encodeURIComponent(org.slug)}`}>
              <UntrustedText value={org.name} />
            </Link>
          ) : (
            <UntrustedText value={org.name} className="row-title" />
          )}
          <div className="muted">
            <code>{org.slug}</code>
          </div>
        </th>
        <td className="numeric">{org.memberCount}</td>
        <td>
          <VerifiedBadge verified={org.verified} />
          {org.verifiedAt ? (
            <div className="muted">since {formatInstant(org.verifiedAt)}</div>
          ) : (
            <div className="muted">members&rsquo; writes land pending</div>
          )}
        </td>
        <td>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => setConfirming(!confirming)}>
              {org.verified ? "Withdraw verification…" : "Verify…"}
            </button>
            <button type="button" disabled={busy} onClick={() => setGranting(!granting)}>
              Grant a membership…
            </button>
          </div>
          {showStubGuard && memberless && !org.verified ? (
            <p className="faint footnote">
              0 members — verifying grants nothing today and arms whoever is added next.
            </p>
          ) : null}
        </td>
      </tr>

      {granting ? (
        <tr>
          <td colSpan={4}>
            <GrantMembership
              org={org}
              busy={busy}
              run={run}
              onDone={() => {
                setGranting(false);
                reload();
              }}
            />
          </td>
        </tr>
      ) : null}

      {confirming ? (
        <tr>
          <td colSpan={4}>
            {org.verified ? (
              <ConfirmPanel
                title={`Withdraw verification from ${org.name}?`}
                confirmLabel="Withdraw verification"
                busyLabel="Withdrawing…"
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                  void run(async () => {
                    await api.review.unverifyOrganization(org.slug);
                    setConfirming(false);
                    reload();
                    return `${org.slug} is no longer verified — its members' writes land pending from now on.`;
                  })
                }
              >
                <p>
                  Its {org.memberCount} member{org.memberCount === 1 ? "" : "s"} stop publishing
                  without review from this moment;{" "}
                  <strong>listings already published stay published</strong>. Its members also lose
                  the ability to decide submissions in their own namespace.
                </p>
              </ConfirmPanel>
            ) : memberless ? (
              /*
               * A MEMBERLESS ORGANISATION IS THE TRAP. Verifying it looks harmless — it grants
               * nothing to nobody today — and that is exactly why it gets done casually, months
               * before somebody is added and silently inherits the right to publish unreviewed.
               * So this is not a confirmation with a warning in it; it refuses and says what to do
               * instead.
               */
              <div className="card card-strong">
                <p className="empty-title">
                  <UntrustedText value={org.name} /> has no members.
                </p>
                <p>
                  Verifying it would grant nothing today and arm whoever is added next — the grant
                  would be made now and collected later, by somebody nobody has reviewed.{" "}
                  <strong>Grant a membership first</strong>, then verify the organisation with its
                  members in front of you.
                </p>
                <p className="row">
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => {
                      setConfirming(false);
                      setGranting(true);
                    }}
                  >
                    Grant a membership
                  </button>
                  <button type="button" onClick={() => setConfirming(false)}>
                    Close
                  </button>
                </p>
              </div>
            ) : (
              <ConfirmPanel
                title={`Verify ${org.name}?`}
                confirmLabel="Verify organisation"
                busyLabel="Verifying…"
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                  void run(async () => {
                    await api.review.verifyOrganization(org.slug);
                    setConfirming(false);
                    reload();
                    return `${org.slug} is verified — its ${org.memberCount} member(s) now publish into that namespace without review.`;
                  })
                }
              >
                <p>
                  Its{" "}
                  <strong>
                    {org.memberCount} member{org.memberCount === 1 ? "" : "s"}
                  </strong>{" "}
                  — and every member added later — will publish anything into the{" "}
                  <code>{org.slug}:</code> namespace immediately and without review.{" "}
                  <strong>This is not a badge; it is a grant of publishing power.</strong>{" "}
                  Withdrawing later stops future writes but already-published listings stay
                  published.
                </p>
              </ConfirmPanel>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Granting an account publishing rights on an organisation.
 *
 * THE API TAKES AN ACCOUNT ID, NOT A HANDLE — `POST /v1/review/organizations/:slug/members` with
 * `{ accountId, role? }`. A reviewer reading a claim knows the handle and never the integer, so this
 * resolves one to the other through the account directory rather than making somebody go and look it
 * up. A bare number is accepted too, because the one place the id IS to hand is the row above.
 *
 * IT MATTERS MORE ON A VERIFIED ORGANISATION, and the confirmation says which case it is: on a
 * verified one this grant is immediately a publishing right over the whole namespace, and on an
 * unverified one it is not — same button, two very different consequences, so they are never worded
 * the same way.
 */
function GrantMembership({
  org,
  busy,
  run,
  onDone,
}: {
  org: OrganizationSummary;
  /*
   * THE GRANT USES THE PARENT'S ACTION, NOT A LOCAL ONE, and that is the fix for a real defect
   * rather than a preference. Confirming a grant closes this panel, which unmounts it — so a note
   * set by a local `useAction` afterwards lands on an unmounted component and is silently dropped.
   * The API's confirmation sentence was composed and then never shown. Verify and withdraw never
   * had the problem because they already used the parent's, whose `<ActionNote>` sits above the
   * table and outlives any row's panel.
   */
  busy: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
  onDone: () => void;
}) {
  const api = useApi();
  /*
   * The account LOOKUP keeps its own action: its note is a transient result count that belongs
   * inside this panel, and the panel is still mounted when it arrives.
   */
  const lookup = useAction();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<OrgRole>("publisher");
  const [candidates, setCandidates] = useState<AccountSummary[] | null>(null);
  const [chosen, setChosen] = useState<AccountSummary | null>(null);

  const find = async () => {
    const typed = query.trim();
    if (typed === "") return;
    setCandidates(null);
    setChosen(null);
    // A bare integer is an id. Anything else is a handle to look up.
    if (/^\d+$/.test(typed)) {
      setChosen({
        id: Number(typed),
        handle: null,
        displayName: null,
        globalRole: "submitter",
        directCreate: false,
        createdAt: "",
      });
      return;
    }
    await lookup.run(async () => {
      const found = await api.review.accounts({ q: typed, limit: 10 });
      setCandidates(found.items);
      return found.items.length === 0
        ? `No account matches “${typed}”.`
        : `${found.items.length} account(s) match “${typed}”.`;
    });
  };

  const name = chosen?.handle ?? (chosen ? `account ${chosen.id}` : "");

  return (
    <div className="card">
      <p className="empty-title">
        Grant a membership on <UntrustedText value={org.name} />
      </p>
      <p className="muted footnote">
        A member may submit into the <code>{org.slug}:</code> namespace.{" "}
        {org.verified ? (
          <>
            This organisation is <strong>verified</strong>, so a member also publishes there without
            review.
          </>
        ) : (
          <>
            This organisation is not verified, so a member&rsquo;s writes still wait for a reviewer.
          </>
        )}
      </p>

      <div className="row">
        <div className="field">
          <label htmlFor={`grant-who-${org.slug}`}>Account handle or id</label>
          <input
            id={`grant-who-${org.slug}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. fil-ops, or 42"
          />
        </div>
        <div className="field">
          <label htmlFor={`grant-role-${org.slug}`}>Role</label>
          <select
            id={`grant-role-${org.slug}`}
            value={role}
            onChange={(event) => setRole(event.target.value as OrgRole)}
          >
            <option value="publisher">{orgRoleLabel("publisher")}</option>
            <option value="admin">{orgRoleLabel("admin")}</option>
            <option value="owner">{orgRoleLabel("owner")}</option>
          </select>
        </div>
        <button
          type="button"
          disabled={busy || lookup.busy || query.trim() === ""}
          onClick={() => void find()}
        >
          {lookup.busy ? "Looking…" : "Find the account"}
        </button>
      </div>

      <ActionNote note={lookup.note} />

      {candidates && !chosen ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Global role</th>
                <th scope="col">Choose</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((account) => (
                <tr key={account.id}>
                  <th scope="row">
                    <UntrustedText value={account.handle} fallback={`account ${account.id}`} />
                    <div className="muted">
                      <code>#{account.id}</code>
                    </div>
                  </th>
                  <td className="muted">{accountRoleLabel(account.globalRole)}</td>
                  <td>
                    <button type="button" onClick={() => setChosen(account)}>
                      Choose
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {chosen ? (
        <ConfirmPanel
          title={`Make ${name} an ${orgRoleLabel(role).toLowerCase()} at ${org.name}?`}
          confirmLabel="Grant the membership"
          busyLabel="Granting…"
          busy={busy}
          onCancel={() => setChosen(null)}
          onConfirm={() =>
            void run(async () => {
              const result = await api.review.grantMembership(org.slug, {
                accountId: chosen.id,
                role,
              });
              onDone();
              return `${name} is now an ${orgRoleLabel(result.role ?? role).toLowerCase()} at ${org.slug}.`;
            })
          }
        >
          {org.verified ? (
            <p>
              <strong>
                They will publish into the <code>{org.slug}:</code> namespace immediately and
                without review
              </strong>{" "}
              — this organisation is verified, so the membership is the whole grant. Nothing else
              has to happen for it to take effect.
            </p>
          ) : (
            <p>
              They may submit into the <code>{org.slug}:</code> namespace, and those submissions{" "}
              <strong>still wait for a reviewer</strong> — this organisation is not verified.
              Verifying it later grants publishing rights to them and to every member added after.
            </p>
          )}
          <p className="muted footnote">
            An <strong>{orgRoleLabel("owner").toLowerCase()}</strong> or{" "}
            <strong>{orgRoleLabel("admin").toLowerCase()}</strong> may also edit the
            organisation&rsquo;s public directory entry; an{" "}
            <strong>{orgRoleLabel("publisher").toLowerCase()}</strong> may not.
          </p>
        </ConfirmPanel>
      ) : null}

      <p className="row">
        <button type="button" disabled={busy || lookup.busy} onClick={onDone}>
          Close
        </button>
      </p>
    </div>
  );
}
