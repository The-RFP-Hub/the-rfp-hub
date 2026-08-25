"use client";

import { AuditAction, AuditActor, AuditFields } from "@/components/AuditPresentation";
/**
 * An organisation's own view of itself: what it has published, what is waiting in its name, and —
 * when it is verified — the decision on each of those.
 *
 * WHO THIS PAGE IS FOR, AND WHY IT IS NOT `/review`. A Hub reviewer decides about anybody. A member
 * here decides about their OWN namespace, and the API scopes them differently: a listing filed under
 * another organisation answers 404 rather than 403, so nothing on this page can be used to find out
 * what is queued elsewhere.
 *
 * THE TWO GATES ARE NOT THE SAME GATE, and the page keeps them visibly apart because the model does:
 *   - ANY membership is enough to SEE this. Verification governs publishing, not visibility, so an
 *     unverified organisation can still find out what has been filed in its name.
 *   - Deciding needs a membership on a VERIFIED organisation. That is the same trust event that
 *     makes a member's own writes publish without review; it would be incoherent to grant one and
 *     withhold the other.
 *
 * THERE IS NO `GET /v1/organizations/:slug`. Identity — name, slug, role, verified — comes from
 * `GET /v1/me`'s membership list, which is also the gate; `verifiedAt` and the public description
 * come from `GET /v1/publishers`, which lists verified organisations only. That is why the "verified
 * on" line appears for a verified organisation and simply is not claimed for an unverified one:
 * there is no date to show, rather than a date being hidden.
 */
import { RequireSession } from "@/components/Chrome";
import { ConfirmPanel } from "@/components/Confirm";
import { UntrustedText } from "@/components/UntrustedText";
import { ListedBadge, ReviewStatusBadge, StatusBadge, VerifiedBadge } from "@/components/badges";
import {
  ActionNote,
  type ActionNoteValue,
  EmptyState,
  ResourceView,
  actionErrorNote,
} from "@/components/states";
import type { OrganizationPatch } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { HOW_IT_WORKS } from "@/lib/links";
import { fundingTypeLabel, orgRoleLabel } from "@/lib/presentation";
import { type ResourceHandle, useResource } from "@/lib/resource";
import { detailHref } from "@/lib/return-to";
import { useApi } from "@/lib/session";
import type {
  ManagedOpportunity,
  ManagedOpportunityList,
  Me,
  MeMembership,
  Publisher,
} from "@/lib/types";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/** Rows per page in both tables. Matches `/listings`, and well under the endpoint's maximum of 100. */
const PAGE_SIZE = 20;

function pageFromUrl(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page > 1 && (page - 1) * PAGE_SIZE <= Number.MAX_SAFE_INTEGER
    ? page
    : 1;
}

function organizationPageHref(slug: string, publishedPage: number, pendingPage: number): string {
  const path = `/organisations/${encodeURIComponent(slug)}`;
  const query = new URLSearchParams();
  if (publishedPage > 1) query.set("publishedPage", String(publishedPage));
  if (pendingPage > 1) query.set("pendingPage", String(pendingPage));
  const encoded = query.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

export default function OrganisationPage() {
  const params = useParams<{ slug: string }>();
  const slug = decodeURIComponent(String(params.slug ?? ""));
  return <RequireSession>{(me) => <Organisation slug={slug} me={me} />}</RequireSession>;
}

function Organisation({ slug, me }: { slug: string; me: Me }) {
  const membership = me.memberships.find((entry) => entry.slug === slug);
  if (!membership) return <NotAMember slug={slug} me={me} />;
  return <Member slug={slug} membership={membership} me={me} />;
}

/**
 * Not a member — said plainly, without pretending the organisation does not exist.
 *
 * The API would answer 403 for a real organisation and 404 for an unknown slug, and this page cannot
 * tell which without asking; it does not guess. What it can say without ambiguity is that THIS
 * account holds no membership on that slug, which is true either way and is the only thing the
 * reader can act on.
 */
function NotAMember({ slug, me }: { slug: string; me: Me }) {
  return (
    <section>
      <h1>
        <code>{slug}</code>
      </h1>
      <div className="state empty">
        <p className="empty-title">You are not a member of this organisation.</p>
        <p className="muted">
          This page shows what an organisation has published and what is waiting in its name, so it
          needs a membership — the API refuses it otherwise, and would refuse it just the same if
          you typed the address directly. A Hub reviewer grants memberships.
        </p>
        <p className="row">
          {me.memberships.length > 0 ? (
            <Link className="button-primary" href="/organisations">
              Your organisations
            </Link>
          ) : (
            <Link className="button-primary" href="/">
              Browse the directory
            </Link>
          )}
          <Link href={HOW_IT_WORKS}>How publishing rights work</Link>
        </p>
      </div>
      {me.canReview ? (
        <p className="muted footnote">
          You have Hub reviewer access, so you can see this organisation from{" "}
          <Link href="/review?tab=organisations">Review queues → Organisations</Link>. That is a
          different view: it is the Hub deciding about an organisation, not the organisation acting
          on itself.
        </p>
      ) : null}
    </section>
  );
}

function Member({
  slug,
  membership,
  me,
}: {
  slug: string;
  membership: MeMembership;
  me: Me;
}) {
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Verified organisations are the public list, so this is where `verifiedAt` and the published
  // description come from. It fails soft: an organisation is not less real because this read did
  // not return, and every line that depends on it is simply omitted rather than guessed.
  const loadPublishers = useCallback(() => api.publishers.list(), [api]);
  const publishers = useResource(loadPublishers);
  const publisher =
    publishers.state.status === "ready"
      ? publishers.state.data.items.find((entry) => entry.slug === slug)
      : undefined;

  const canDecide = membership.verified;
  const canEdit = membership.role === "owner" || membership.role === "admin";

  /*
   * BOTH LISTS ARE OWNED HERE, because a decision moves a row from one to the other.
   *
   * They are two reads of the same data with different filters: approving a pending listing does
   * not just empty a row out of "Awaiting review", it fills one in under "Published". Reloading
   * only the list the button was in left the published table stale until somebody reloaded the
   * page — the listing had been published and the page said it had not.
   */
  /*
   * A PAGE PER LIST. Both used to ask for the first fifty rows and nothing else, so an organisation
   * with more than fifty had rows that could not be reached at all — and on the pending side that
   * meant submissions in its own namespace that it could not decide from the only page that offers
   * the decision.
   *
   * The two paginate INDEPENDENTLY because they are independent readings: moving through published
   * history has nothing to do with where you are in the review queue, and one control driving both
   * would move a reader away from the thing they were working on.
   *
   * A decision re-runs whichever `load` is current, and each closes over its own page — so
   * approving a row on page 3 refreshes page 3, rather than silently returning to the top.
   */
  const [publishedPage, setPublishedPage] = useState(() =>
    pageFromUrl(searchParams?.get("publishedPage")),
  );
  const [pendingPage, setPendingPage] = useState(() =>
    pageFromUrl(searchParams?.get("pendingPage")),
  );
  const origin = organizationPageHref(slug, publishedPage, pendingPage);

  const movePublished = (page: number) => {
    setPublishedPage(page);
    router.replace(organizationPageHref(slug, page, pendingPage));
  };
  const movePending = (page: number) => {
    setPendingPage(page);
    router.replace(organizationPageHref(slug, publishedPage, page));
  };

  const loadPublished = useCallback(
    () =>
      api.organizations.opportunities(slug, {
        reviewStatus: "approved",
        page: publishedPage,
        limit: PAGE_SIZE,
      }),
    [api, slug, publishedPage],
  );
  const loadPending = useCallback(
    () =>
      api.organizations.opportunities(slug, {
        reviewStatus: "pending",
        page: pendingPage,
        limit: PAGE_SIZE,
      }),
    [api, slug, pendingPage],
  );
  const published = useResource(loadPublished);
  const awaiting = useResource(loadPending);

  // A decision removes a row from the pending result. If it was the only row on the last page,
  // the server truthfully returns that now-out-of-range page as empty and reports a smaller
  // `totalPages`; staying there would render "Nothing is waiting" while earlier pages still hold
  // rows, with no pager in the empty branch to escape through. Follow the new last page and let the
  // ordinary resource generation guard discard any superseded response.
  useEffect(() => {
    if (
      awaiting.state.status === "ready" &&
      awaiting.state.data.page > awaiting.state.data.totalPages
    ) {
      const page = awaiting.state.data.totalPages;
      setPendingPage(page);
      router.replace(organizationPageHref(slug, publishedPage, page));
    }
  }, [awaiting.state, publishedPage, router, slug]);

  const reloadBoth = useCallback(() => {
    published.reload();
    awaiting.reload();
  }, [published.reload, awaiting.reload]);

  return (
    <section>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>
          <UntrustedText value={membership.name} />
        </h1>
        <code>{slug}</code>
        <VerifiedBadge verified={membership.verified} />
      </div>

      <p className="muted">
        {/*
         * BOTH CONDITIONS, and the membership is the one that decides. `verified` arrives with the
         * session and is the flag the API actually gates on; `verifiedAt` is a date from the public
         * publishers list. If they ever disagree — a stale public read, a verification withdrawn
         * seconds ago — the gate is right and the date is decoration, so the date is never shown
         * without it.
         */}
        {membership.verified && publisher?.verifiedAt ? (
          <>
            Verified {formatInstant(publisher.verifiedAt)} — members&rsquo; listings have published
            without review since then.{" "}
          </>
        ) : null}
        You are an <strong>{orgRoleLabel(membership.role).toLowerCase()}</strong> here.
      </p>

      {membership.verified ? (
        <div className="card card-strong">
          <p className="empty-title">You publish directly.</p>
          <p>
            Anything you submit with an id starting <code>{slug}:</code> goes into the public
            directory immediately, without review. Anything else waits for a reviewer like
            everyone&rsquo;s.
          </p>
        </div>
      ) : (
        <div className="card card-strong">
          <p className="empty-title">Your listings wait for a reviewer.</p>
          <p>
            This organisation is not verified, so a listing you submit under <code>{slug}:</code>{" "}
            lands pending like any other submission. Verification is what changes that — it is a
            reviewer&rsquo;s decision, and it grants every member the right to publish here without
            review. <Link href={HOW_IT_WORKS}>How that works</Link>.
          </p>
        </div>
      )}

      {/*
        THE ORIGIN DESCRIBES ITSELF ONCE. Every link out of this page carries where it came from, so
        a member who opens a submission from here gets "← Back to Filecoin Foundation" rather than a
        browser button that cannot say where it goes. The organisation's own name is the label
        because a slug is not what anybody calls it.
      */}
      <Published
        resource={published}
        back={origin}
        label={membership.name}
        onPage={movePublished}
      />
      <AwaitingReview
        resource={awaiting}
        slug={slug}
        canDecide={canDecide}
        me={me}
        back={origin}
        label={membership.name}
        onDecided={reloadBoth}
        onPage={movePending}
      />
      <DirectoryEntry
        slug={slug}
        membership={membership}
        canEdit={canEdit}
        publisher={publisher}
        seedSettled={publishers.state.status === "ready" || publishers.state.status === "error"}
      />
    </section>
  );
}

/**
 * The pager, shared by both tables.
 *
 * `<nav>` with its own label because there are TWO on this page and "Previous/Next" alone does not
 * say previous what — a screen reader lands on the second set with no way to tell it from the first.
 */
function Pager({
  list,
  onPage,
  label,
}: {
  list: ManagedOpportunityList;
  onPage: (page: number) => void;
  label: string;
}) {
  if (list.totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" disabled={list.page <= 1} onClick={() => onPage(list.page - 1)}>
        Previous
      </button>
      <span className="muted">
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
  );
}

/** What this organisation has actually published. */
function Published({
  resource,
  back,
  label,
  onPage,
}: {
  resource: ResourceHandle<ManagedOpportunityList>;
  back: string;
  label: string;
  onPage: (page: number) => void;
}) {
  const { state, reload } = resource;

  return (
    <>
      <h2 className="section-head">
        Published for this organisation
        {state.status === "ready" ? ` · ${state.data.total}` : null}
      </h2>
      <ResourceView resource={state} what="this organisation's listings" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="Nothing published for this organisation yet."
              detail="Listings submitted with an id starting with this organisation's slug appear here once they are approved."
              action={
                <Link className="button-primary" href="/listings/new">
                  Submit an opportunity
                </Link>
              }
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Listing</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    <th scope="col">Submitted by</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <Link
                          className="row-title"
                          href={detailHref("/listings", item.id, back, label)}
                        >
                          <UntrustedText value={item.title} />
                        </Link>
                        <div className="muted">
                          <code>{item.id}</code>
                        </div>
                      </th>
                      <td className="muted">{fundingTypeLabel(item.fundingType)}</td>
                      <td>
                        <StatusBadge status={item.status} />
                        {/*
                          APPROVED IS NOT THE SAME AS PUBLIC. Listing is a separate axis: a reviewer
                          can withhold an approved listing, and then the public reads 404 it exactly
                          as they would a pending one. Shown under a heading that says "Published",
                          an unmarked row like this reads as live — so it says what it is, in the
                          same badge vocabulary as everything else, with the consequence spelled out
                          rather than left to a tooltip nobody hovers.
                        */}
                        {item.isListed ? null : (
                          <>
                            {" "}
                            <ListedBadge isListed={false} />
                            <div className="cell-note muted">
                              Approved but hidden from the public directory — a Hub reviewer
                              controls listing.
                            </div>
                          </>
                        )}
                      </td>
                      <td className="muted">
                        <UntrustedText value={item.submittedBy} fallback="community" />
                      </td>
                      <td className="muted numeric">{formatInstant(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Withheld list={list} />
              <Pager list={list} onPage={onPage} label="Published listing pages" />
            </div>
          )
        }
      </ResourceView>
    </>
  );
}

/**
 * How many rows on THIS PAGE are approved but not public.
 *
 * Per page rather than per namespace, and it says so: the total in the heading comes from the API
 * and counts every approved row, listed or not, and there is no count of the withheld ones to ask
 * for. Claiming a namespace-wide number from one page of rows would be inventing it.
 */
function Withheld({ list }: { list: ManagedOpportunityList }) {
  const count = list.items.filter((item) => !item.isListed).length;
  if (count === 0) return null;
  return (
    <p className="muted footnote">
      {count === 1 ? "One listing on this page is" : `${count} listings on this page are`} approved
      but <strong>hidden from the public directory</strong>, so{" "}
      {count === 1 ? "it has" : "they have"}
      no public detail page. Visibility is a Hub reviewer&rsquo;s control, separate from approval.
    </p>
  );
}

/**
 * What somebody else has filed in this organisation's name.
 *
 * THE SENTENCE UNDER THE HEADING IS LOAD-BEARING. A member seeing two rows here will reasonably
 * assume they are seeing everything queued about them, and they are not: only entries filed INTO
 * this namespace appear, and only a reviewer sees the rest of the queue. Saying so is what stops
 * this page being read as a guarantee it cannot make.
 */
function AwaitingReview({
  resource,
  slug,
  canDecide,
  me,
  back,
  label,
  onDecided,
  onPage,
}: {
  resource: ResourceHandle<ManagedOpportunityList>;
  slug: string;
  canDecide: boolean;
  me: Me;
  back: string;
  label: string;
  /** Refreshes BOTH lists — an approval moves a row between them. */
  onDecided: () => void;
  onPage: (page: number) => void;
}) {
  const { state, reload } = resource;
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  return (
    <>
      <h2 className="section-head">
        Awaiting review for this organisation
        {state.status === "ready" ? ` · ${state.data.total}` : null}
      </h2>
      <p className="muted footnote">
        Filed with the <code>{slug}:</code> organisation prefix by people outside the organisation.
        You can see them because they carry your organisation&rsquo;s name.{" "}
        {canDecide ? (
          <>
            Because <code>{slug}</code> is verified, you can decide them yourself — a Hub reviewer
            can too.
          </>
        ) : (
          <>A Hub reviewer decides whether they publish.</>
        )}
      </p>
      <ActionNote note={note} />
      <ResourceView resource={state} what="submissions awaiting review" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="Nothing is waiting for this organisation."
              detail="If somebody submits a listing under this organisation's slug, it appears here while it waits."
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Listing</th>
                    <th scope="col">Type</th>
                    <th scope="col">State</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">{canDecide ? "Decision" : "History"}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((item) => (
                    <PendingRow
                      key={item.id}
                      item={item}
                      slug={slug}
                      canDecide={canDecide}
                      me={me}
                      back={back}
                      label={label}
                      onDecided={(message) => {
                        setNote({ kind: "ok", message });
                        onDecided();
                      }}
                      onFailed={(failure) => setNote(failure)}
                    />
                  ))}
                </tbody>
              </table>
              <Pager list={list} onPage={onPage} label="Pages of submissions awaiting review" />
            </div>
          )
        }
      </ResourceView>
      <p className="muted footnote">
        If somebody has listed an opportunity in your name that is not here, it has not been
        submitted to the Hub — only reviewers see the rest of the queue. <strong>Claim</strong> asks
        a reviewer to transfer an existing listing to this organisation, and lives on the listing
        itself.
      </p>
    </>
  );
}

type RowPanel = "none" | "history" | "approve" | "reject";

function PendingRow({
  item,
  slug,
  canDecide,
  me,
  back,
  label,
  onDecided,
  onFailed,
}: {
  item: ManagedOpportunity;
  slug: string;
  canDecide: boolean;
  me: Me;
  back: string;
  label: string;
  onDecided: (message: string) => void;
  onFailed: (failure: ActionNoteValue) => void;
}) {
  const [panel, setPanel] = useState<RowPanel>("none");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const api = useApi();

  /** How the decision will be attributed. The API records the handle, never a coarse "reviewer". */
  const attribution = me.handle ? `@${me.handle}` : `account ${me.accountId}`;

  const decide = async (action: "approve" | "reject") => {
    setBusy(true);
    try {
      if (action === "approve") {
        await api.organizations.approve(slug, item.id);
        onDecided(`${item.id} is published. The decision is recorded under ${attribution}.`);
      } else {
        await api.organizations.reject(slug, item.id, reason.trim());
        onDecided(`${item.id} was refused. The reason is shown to whoever submitted it.`);
      }
      setPanel("none");
      setReason("");
    } catch (error) {
      onFailed(actionErrorNote(error, "The decision could not be recorded."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr>
        <th scope="row">
          <Link className="row-title" href={detailHref("/listings", item.id, back, label)}>
            <UntrustedText value={item.title} />
          </Link>
          <div className="muted">
            <code>{item.id}</code>
          </div>
        </th>
        <td className="muted">{fundingTypeLabel(item.fundingType)}</td>
        <td>
          <ReviewStatusBadge status={item.reviewStatus} />
        </td>
        <td className="muted">
          <UntrustedText value={item.submittedBy} fallback="community" />
          <div className="faint">{formatInstant(item.createdAt)}</div>
        </td>
        <td>
          <div className="row">
            {canDecide ? (
              <>
                <button
                  type="button"
                  onClick={() => setPanel(panel === "approve" ? "none" : "approve")}
                >
                  Approve…
                </button>
                <button
                  type="button"
                  onClick={() => setPanel(panel === "reject" ? "none" : "reject")}
                >
                  Reject…
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setPanel(panel === "history" ? "none" : "history")}
            >
              History
            </button>
          </div>
        </td>
      </tr>

      {panel !== "none" ? (
        <tr>
          <td colSpan={5}>
            {panel === "history" ? <History id={item.id} /> : null}
            {panel === "approve" ? (
              <ConfirmPanel
                title="Publish this listing?"
                confirmLabel="Publish it"
                busyLabel="Publishing…"
                busy={busy}
                onConfirm={() => void decide("approve")}
                onCancel={() => setPanel("none")}
              >
                <p>
                  It publishes into the public directory immediately, in{" "}
                  <strong>
                    <UntrustedText value={slug} />
                  </strong>
                  &rsquo;s name — anyone reading the Hub will see it as this organisation&rsquo;s.
                  The decision is recorded under <strong>{attribution}</strong>.
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
                onConfirm={() => void decide("reject")}
                onCancel={() => setPanel("none")}
              >
                <p>
                  It stays out of the public directory and is unlisted.{" "}
                  <strong>A reason is required</strong> — anyone may submit a listing about an
                  organisation, so refusing one in your own namespace is attributed to you by name
                  rather than to the Hub. Your reason is shown to whoever submitted it, and the
                  decision is recorded under <strong>{attribution}</strong>.
                </p>
                <div className="field">
                  <label htmlFor={`reject-reason-${item.id}`}>Reason</label>
                  <p className="hint">
                    Written for the submitter. Say what is wrong with the record, not what you think
                    of the programme.
                  </p>
                  <input
                    id={`reject-reason-${item.id}`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="e.g. this is not our programme — we have never run it"
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
 * The public, redacted audit trail for one row.
 *
 * The same read a member of the public gets — action, time, coarse actor, changed field NAMES, never
 * the values. A member of the organisation is not entitled to more here: the entry is somebody
 * else's submission until it is approved.
 */
function History({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.audit(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <div className="card">
      <p className="muted footnote">
        Every change to this record, as the public sees it: what happened and which fields moved,
        never the values.
      </p>
      <ResourceView resource={state} what="the history" onRetry={reload}>
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
                      <td className="muted numeric">{formatInstant(entry.at)}</td>
                      <td>
                        <AuditAction entry={entry} />
                      </td>
                      <td>
                        <AuditActor entry={entry} />
                      </td>
                      <td>
                        <AuditFields fields={entry.changedFields} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </div>
  );
}

/**
 * The organisation's public identity, edited in place.
 *
 * OWNER OR ADMIN ONLY, which is the API's rule and not this page's — a `publisher` member may
 * submit into the namespace but may not rename the organisation on every listing that names it.
 *
 * WHAT THE FORM DOES NOT DO: the PATCH response is an `OrganizationSummary`, which carries `name`,
 * `website` and `ecosystems` but NOT `description`. So a saved description cannot be read back from
 * the answer, and this form does not pretend to: it says the change was accepted rather than
 * re-rendering a value it did not receive. `description` is seeded from the public publishers list
 * where there is one.
 */
function DirectoryEntry({
  slug,
  membership,
  canEdit,
  publisher,
  seedSettled,
}: {
  slug: string;
  membership: MeMembership;
  canEdit: boolean;
  /** The public record, where there is one. The only source for the current website/description. */
  publisher?: Publisher;
  /**
   * Whether the public record has been ASKED FOR AND ANSWERED — either way.
   *
   * The form seeds from that record when it opens, so opening it before the read settles would show
   * an empty website box for an organisation that has one. That is not merely cosmetic here: an
   * empty box invites a reader to fill it in, and the box they are looking at is the one that
   * decides what every listing naming this organisation says.
   */
  seedSettled: boolean;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(membership.name);
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  /**
   * WHAT THE FIELDS HELD WHEN THE FORM WAS OPENED, so `save` can send only what moved.
   *
   * A PATCH that always sent every field DESTROYED DATA: the form started blank, so saving a
   * name-only change sent `website: null, description: null` and wiped both. Sending only changed
   * keys makes an untouched field impossible to clear by accident, and it is also the only correct
   * behaviour for an unverified organisation — there is no public record to read its current
   * website from, so the form cannot show it and must not overwrite it either.
   */
  const [baseline, setBaseline] = useState({ name: membership.name, website: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  /*
   * SEEDED WHEN THE FORM OPENS, not at mount. The public record arrives asynchronously and a
   * `useState` initial value is captured once — seeding at mount would leave the fields blank for
   * exactly the readers whose data had not loaded yet, which is the case this bug came from.
   */
  const openForm = () => {
    const seed = {
      name: membership.name,
      website: publisher?.website ?? "",
      description: publisher?.description ?? "",
    };
    setName(seed.name);
    setWebsite(seed.website);
    setDescription(seed.description);
    setBaseline(seed);
    setNote(null);
    setOpen(true);
  };

  const save = async () => {
    const patch: OrganizationPatch = {};
    if (name.trim() !== baseline.name) patch.name = name.trim();
    if (website.trim() !== baseline.website) {
      patch.website = website.trim() === "" ? null : website.trim();
    }
    if (description.trim() !== baseline.description) {
      patch.description = description.trim() === "" ? null : description.trim();
    }
    if (Object.keys(patch).length === 0) {
      setNote({ kind: "ok", message: "Nothing changed." });
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      await api.organizations.update(slug, patch);
      setBaseline({
        name: name.trim(),
        website: website.trim(),
        description: description.trim(),
      });
      setNote({
        kind: "ok",
        message: "Saved. The change appears on every listing that names this organisation.",
      });
    } catch (error) {
      setNote(actionErrorNote(error, "The change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="section-head">Directory entry</h2>
      <p className="muted footnote">
        The name, website and description shown on every listing that names this organisation.
      </p>
      {!canEdit ? (
        <p className="muted">
          Editing it needs the <strong>organisation owner</strong> or{" "}
          <strong>organisation admin</strong> role; you are an{" "}
          <strong>{orgRoleLabel(membership.role).toLowerCase()}</strong>. An organisation owner can
          change your role, and a Hub reviewer can change theirs.
        </p>
      ) : !seedSettled ? (
        <p className="muted">Loading the current entry…</p>
      ) : !open ? (
        <p>
          <button type="button" onClick={openForm}>
            Edit the organisation&rsquo;s entry
          </button>
        </p>
      ) : (
        <div className="card">
          <div className="field">
            <label htmlFor="org-name">Name</label>
            <input id="org-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="org-website">Website</label>
            <p className="hint">
              {publisher
                ? "Clearing it removes the website from every listing that names this organisation."
                : "This organisation has no public record to read the current value from, so this box starts empty. Leaving it empty changes nothing; typing something replaces whatever is stored."}
            </p>
            <input
              id="org-website"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="https://example.org"
            />
          </div>
          <div className="field">
            <label htmlFor="org-description">Description</label>
            <p className="hint">
              One or two sentences.{" "}
              {publisher
                ? "This value is not returned after saving, so it is not re-read here."
                : "No public record exists for this organisation yet, so this box starts empty; leaving it empty changes nothing."}
            </p>
            <input
              id="org-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <p className="row">
            <button
              type="button"
              className="button-primary"
              disabled={busy || name.trim() === ""}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </button>
          </p>
          <ActionNote note={note} />
        </div>
      )}
    </>
  );
}
