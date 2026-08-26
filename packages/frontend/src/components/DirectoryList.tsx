"use client";

/**
 * The public directory: every PUBLISHED opportunity, as a visitor with no account reads it.
 *
 * NO SESSION IS INVOLVED, and that is the point. `GET /v1/opportunities` is unauthenticated, the API
 * client attaches an `Authorization` header only when there is a token to attach, and this component
 * never asks for one — so it renders identically for a signed-in publisher and for somebody who has
 * never seen this deployment before. A signed-in reader is not shown more here: the route serves
 * `approved AND is_listed` listings and nothing else, whoever asks.
 *
 * EVERY FILTER IS A PARAMETER THE ENDPOINT DECLARES. The list route validates its querystring with
 * `additionalProperties: false`, so an invented filter is a 400 rather than a control that quietly
 * does nothing; `lib/directory.ts` builds the query and is unit-tested for exactly that. The filter
 * values themselves are read out of the Standard's schema, so the six funding types and four
 * statuses offered here cannot drift from the ones the API accepts.
 *
 * THE SELECTION LIVES IN THE ADDRESS BAR, not in this component. `searchParams` is the single
 * source of truth for what is being shown; the local state below is only the DRAFT the reader is
 * editing. Three bugs died with that change and they were all the same bug:
 *
 *   1. A DRAFT WAS SILENTLY DISCARDED. The two free-text boxes were applied on submit while the
 *      three selects applied on change — so typing "zk" and then choosing a funding type ran a
 *      search for the funding type alone, with "zk" still sitting on screen looking as though it
 *      had been used. Every control now commits the WHOLE draft, so what is on screen is what was
 *      asked for.
 *   2. BACK WENT NOWHERE USEFUL. Filter, open a listing, press Back — and the reader landed on an
 *      unfiltered first page having lost the search they came for.
 *   3. A FILTERED VIEW COULD NOT BE SHARED OR RELOADED.
 */
import { UntrustedText } from "@/components/UntrustedText";
import { StatusBadge } from "@/components/badges";
import { EmptyState, ResourceView } from "@/components/states";
import {
  DEFAULT_SELECTION,
  type DirectorySelection,
  FUNDING_TYPES,
  ORDERINGS,
  type Ordering,
  STATUSES,
  SUGGESTED_ECOSYSTEMS,
  directoryQuery,
  isFiltered,
  selectionFromParams,
  selectionToHref,
} from "@/lib/directory";
import { describeDeadline, formatCount } from "@/lib/format";
import { HOW_IT_WORKS } from "@/lib/links";
import { fundingTypeLabel, opportunityStatusLabel } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { OpportunitySummary } from "@/lib/types";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

export function DirectoryList() {
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();

  // WHAT IS BEING SHOWN — parsed from the URL on every render, so a back button, a reload and a
  // pasted link all arrive at the same place by the same path.
  const applied = useMemo(
    () => selectionFromParams(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

  // WHAT THE READER IS EDITING. Seeded from the URL and re-seeded whenever it changes underneath —
  // which is what makes the controls follow a back button instead of contradicting it.
  const [draft, setDraft] = useState<DirectorySelection>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const load = useCallback(() => api.directory.list(directoryQuery(applied)), [api, applied]);
  const { state, reload } = useResource(load);

  /**
   * Commit a change. Every commit carries the ENTIRE draft, which is the fix for the discarded-text
   * bug: there is no path through this component that sends one control's value and drops another's.
   *
   * `push`, not `replace`, so each filtering step is a history entry a reader can walk back out of.
   */
  const commit = useCallback(
    (patch: Partial<DirectorySelection>) => {
      // Any change to a filter returns to page 1 — page 4 of the previous result is not page 4 of
      // this one. A page change passes `page` explicitly and overrides this.
      const next = { ...draft, ...patch, page: patch.page ?? 1 };
      setDraft(next);
      router.push(selectionToHref(next));
    },
    [draft, router],
  );

  const search = (event: FormEvent) => {
    event.preventDefault();
    commit({});
  };

  return (
    <>
      {/*
       * A <search> LANDMARK around the filter bar. Screen-reader users navigate a page by landmark
       * before they navigate it by control, and "the thing that narrows this list" is one of the two
       * places anybody arrives on this page wanting to be. The element carries the role natively,
       * which is why it is an element rather than `role="search"` on the form.
       */}
      <search>
        <form className="filters" onSubmit={search}>
          <div className={`field${draft.q.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-q">Search</label>
            <input
              id="directory-q"
              type="search"
              value={draft.q}
              onChange={(event) => setDraft({ ...draft, q: event.target.value })}
              placeholder="storage, zk, retrieval…"
            />
          </div>

          {/*
           * A DATALIST, NOT A SELECT. `ecosystems[]` is free text in the Standard — it is whatever a
           * publisher called their own ecosystem — so a closed list would hide real listings whose
           * spelling is not in it. This offers the common ones and still accepts anything typed.
           *
           * Written assuming the API matches case-insensitively: the live corpus carries both
           * `Ethereum` and `ethereum`, and `Filecoin` and `filecoin`, so an exact-match filter answers
           * a reader who typed the wrong case with an empty page about a well-populated ecosystem.
           */}
          <div className={`field${draft.ecosystem.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-ecosystem">Ecosystem</label>
            <input
              id="directory-ecosystem"
              list="directory-ecosystems"
              value={draft.ecosystem}
              onChange={(event) => setDraft({ ...draft, ecosystem: event.target.value })}
              placeholder="Any ecosystem"
            />
            <datalist id="directory-ecosystems">
              {SUGGESTED_ECOSYSTEMS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className={`field${draft.fundingType ? " is-set" : ""}`}>
            <label htmlFor="directory-type">Funding type</label>
            <select
              id="directory-type"
              value={draft.fundingType}
              onChange={(event) => commit({ fundingType: event.target.value })}
            >
              <option value="">Any type</option>
              {FUNDING_TYPES.map((value) => (
                <option key={value} value={value}>
                  {fundingTypeLabel(value)}
                </option>
              ))}
            </select>
          </div>

          {/*
           * THE DEFAULT IS VISIBLE. This control opens holding `open` rather than blank, because the
           * list it is describing is already narrowed to open opportunities — a filter the reader
           * cannot see is a filter they cannot undo.
           */}
          <div className={`field${draft.status ? " is-set" : ""}`}>
            <label htmlFor="directory-status">Status</label>
            <select
              id="directory-status"
              value={draft.status}
              onChange={(event) => commit({ status: event.target.value })}
            >
              <option value="">Any status</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {opportunityStatusLabel(value)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="directory-order">Order by</label>
            <select
              id="directory-order"
              value={draft.ordering}
              onChange={(event) => commit({ ordering: event.target.value as Ordering })}
            >
              {ORDERINGS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field field-action">
            <button type="submit" className="button-primary">
              Search
            </button>
          </div>
        </form>
      </search>

      <ResourceView resource={state} what="the directory" onRetry={reload}>
        {(list) => (
          <>
            <ResultLine
              applied={applied}
              total={list.total}
              page={list.page}
              totalPages={list.totalPages}
              stale={state.status === "ready" && state.stale}
            />

            {list.items.length === 0 ? (
              <EmptyState
                title={
                  isFiltered(applied) ? "Nothing matches those filters." : "Nothing published yet."
                }
                detail={
                  isFiltered(applied)
                    ? "Funding type and status match exactly; the search box matches words in the title, summary and description."
                    : "This directory lists opportunities a reviewer has approved and listed. There are none yet."
                }
                action={
                  isFiltered(applied) ? (
                    <>
                      <Link href={selectionToHref(DEFAULT_SELECTION)}>Clear the filters</Link>
                      <Link href={HOW_IT_WORKS}>Do you run a programme?</Link>
                    </>
                  ) : (
                    <Link href={HOW_IT_WORKS}>Do you run a programme?</Link>
                  )
                }
              />
            ) : (
              <>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Opportunity</th>
                        <th scope="col">Organisation</th>
                        <th scope="col">Type</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="numeric">
                          Next deadline
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((item) => (
                        <DirectoryRow key={item.id} item={item} />
                      ))}
                    </tbody>
                  </table>
                </div>

                <nav className="pagination" aria-label="Directory pages">
                  <button
                    type="button"
                    disabled={list.page <= 1}
                    onClick={() => commit({ page: list.page - 1 })}
                  >
                    Previous
                  </button>
                  <span className="muted">
                    Page {list.page} of {list.totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={list.page >= list.totalPages}
                    onClick={() => commit({ page: list.page + 1 })}
                  >
                    Next
                  </button>
                </nav>
              </>
            )}
          </>
        )}
      </ResourceView>
    </>
  );
}

/**
 * What is on screen, in words, plus the one-click way out of the default narrowing.
 *
 * The toggle is a LINK rather than a button so that the state it leads to is an address: it can be
 * middle-clicked, bookmarked and sent to somebody. That it also happens to make the back button
 * work is a consequence of the same decision, not a second mechanism.
 */
function ResultLine({
  applied,
  total,
  page,
  totalPages,
  stale,
}: {
  applied: DirectorySelection;
  total: number;
  page: number;
  totalPages: number;
  stale: boolean;
}) {
  const noun = total === 1 ? "opportunity" : "opportunities";
  const status = applied.status ? `${opportunityStatusLabel(applied.status).toLowerCase()} ` : "";
  const narrowed = applied.status === DEFAULT_SELECTION.status;

  return (
    <div className="result-line">
      <p>
        <strong>
          {formatCount(total)} {status}
          {noun}
        </strong>
        {applied.ecosystem.trim() ? (
          <>
            {" "}
            on <UntrustedText value={applied.ecosystem.trim()} />
          </>
        ) : null}{" "}
        · page {page} of {totalPages}
        {stale ? <span className="muted"> · refreshing…</span> : null}
      </p>
      {narrowed ? (
        <Link href={selectionToHref({ ...applied, status: "", page: 1 })}>
          Include closed and upcoming
        </Link>
      ) : applied.status === "" ? (
        <Link href={selectionToHref({ ...applied, status: DEFAULT_SELECTION.status, page: 1 })}>
          Show only what is open
        </Link>
      ) : (
        <Link href={selectionToHref({ ...applied, status: "", page: 1 })}>Show every status</Link>
      )}
    </div>
  );
}

/**
 * One row.
 *
 * `operatingOrganizations` is a required, order-significant array whose entry 0 is the organisation
 * to display — the party that actually runs the intake. Sponsors are a different array and are left
 * to the detail page: naming a backer in a column headed "Organisation" would misattribute who a
 * reader is applying to.
 *
 * THE RAW ID IS GONE FROM THE ROW and the publisher's own summary took its place. `acme:round-4`
 * is a join key: it tells a reader nothing about whether to click, it is the widest thing in the
 * cell, and it was sitting directly under the title in the position a scanning eye reads second.
 * The summary is the sentence the publisher wrote to answer exactly that question. The id is still
 * a click away, in mono, on the listing's own page — where somebody who wants it is looking.
 */
export function DirectoryRow({ item }: { item: OpportunitySummary }) {
  const operator = item.operatingOrganizations[0];
  return (
    <tr>
      <th scope="row">
        <Link href={`/opportunities/${encodeURIComponent(item.id)}`} className="row-title">
          <UntrustedText value={item.title} />
        </Link>
        {item.summary?.trim() ? (
          <div className="row-summary">
            <UntrustedText value={item.summary} />
          </div>
        ) : null}
      </th>
      <td className="muted">
        <UntrustedText value={operator?.name} />
      </td>
      <td>{fundingTypeLabel(item.fundingType)}</td>
      <td>
        <StatusBadge status={item.status} />
      </td>
      <td className="numeric">{describeDeadline(item.deadlines)}</td>
    </tr>
  );
}
