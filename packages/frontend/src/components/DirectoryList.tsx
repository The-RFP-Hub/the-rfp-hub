"use client";

import { DecorativeIcon, type HeroIcon, IconLabel } from "@/components/IconLabel";
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
import { EmptyState, ResourceView, TechnicalDetails } from "@/components/states";
import {
  DEFAULT_SELECTION,
  type DirectorySelection,
  FUNDING_TYPES,
  ORDERINGS,
  type Ordering,
  STATUSES,
  SUGGESTED_ECOSYSTEMS,
  awardInputValue,
  dateInputValue,
  directoryQuery,
  emptyResultHints,
  isFiltered,
  selectionFromParams,
  selectionToHref,
  truncateForDisplay,
} from "@/lib/directory";
import { describeDirectoryDeadline, formatCount } from "@/lib/format";
import { HOW_IT_WORKS } from "@/lib/links";
import { fundingTypeLabel, opportunityStatusLabel } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { FundingType, OpportunitySummary } from "@/lib/types";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsUpDownIcon,
  BanknotesIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  RocketLaunchIcon,
  SignalIcon,
  TagIcon,
  TrophyIcon,
} from "@heroicons/react/20/solid";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

/** One quickly recognizable silhouette per opportunity type, backed by the written Type column. */
const FUNDING_TYPE_ICONS: Readonly<Record<FundingType, HeroIcon>> = {
  rfp: DocumentTextIcon,
  grant: BanknotesIcon,
  hackathon: CodeBracketIcon,
  bounty: TrophyIcon,
  accelerator: RocketLaunchIcon,
  vc_fund: BuildingOffice2Icon,
};

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
            <label htmlFor="directory-q">
              <IconLabel icon={MagnifyingGlassIcon}>Search</IconLabel>
            </label>
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
            <label htmlFor="directory-ecosystem">
              <IconLabel icon={GlobeAltIcon}>Ecosystem</IconLabel>
            </label>
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
            <label htmlFor="directory-type">
              <IconLabel icon={BanknotesIcon}>Funding type</IconLabel>
            </label>
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
            <label htmlFor="directory-status">
              <IconLabel icon={SignalIcon}>Status</IconLabel>
            </label>
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
            <label htmlFor="directory-order">
              <IconLabel icon={ArrowsUpDownIcon}>Order by</IconLabel>
            </label>
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

          <div className={`field${draft.category.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-category">
              <IconLabel icon={TagIcon}>Category</IconLabel>
            </label>
            <input
              id="directory-category"
              value={draft.category}
              onChange={(event) => setDraft({ ...draft, category: event.target.value })}
              placeholder="Any category"
            />
          </div>

          {/*
           * A slug, and the hint says what it matches: the API's `organization` param is wider than
           * the label suggests — operating AND sponsoring organizations, not only the one in the
           * "Organization" column. It is also the param a `/publishers` card links here with.
           */}
          <div className={`field${draft.organization.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-organization">
              <IconLabel icon={BuildingOffice2Icon}>Organization</IconLabel>
            </label>
            <input
              id="directory-organization"
              value={draft.organization}
              onChange={(event) => setDraft({ ...draft, organization: event.target.value })}
              placeholder="Organization slug"
            />
            <p className="hint">Matches the operating OR the sponsoring organization.</p>
          </div>

          <div className={`field${draft.minAward.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-min-award">
              <IconLabel icon={ArrowUpIcon}>Min award/budget</IconLabel>
            </label>
            <input
              id="directory-min-award"
              type="number"
              step="any"
              inputMode="decimal"
              value={awardInputValue(draft.minAward)}
              onChange={(event) => setDraft({ ...draft, minAward: event.target.value })}
              placeholder="No minimum"
            />
            <p className="hint">
              Compares a listing&rsquo;s award amount; one that states only a total program budget
              (no award range) is compared using that budget instead.
            </p>
            {/* The control renders blank for `?minAward=abc`, but the value IS still sent. */}
            {draft.minAward.trim() && awardInputValue(draft.minAward) !== draft.minAward.trim() ? (
              <p className="hint">
                Filtering on the exact value from the link:{" "}
                <code className="wrap-anywhere">
                  <UntrustedText value={truncateForDisplay(draft.minAward.trim())} />
                </code>
              </p>
            ) : null}
          </div>

          <div className={`field${draft.maxAward.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-max-award">
              <IconLabel icon={ArrowDownIcon}>Max award/budget</IconLabel>
            </label>
            <input
              id="directory-max-award"
              type="number"
              step="any"
              inputMode="decimal"
              value={awardInputValue(draft.maxAward)}
              onChange={(event) => setDraft({ ...draft, maxAward: event.target.value })}
              placeholder="No maximum"
            />
            <p className="hint">
              Compares a listing&rsquo;s award amount; one that states only a total program budget
              (no award range) is compared using that budget instead.
            </p>
            {draft.maxAward.trim() && awardInputValue(draft.maxAward) !== draft.maxAward.trim() ? (
              <p className="hint">
                Filtering on the exact value from the link:{" "}
                <code className="wrap-anywhere">
                  <UntrustedText value={truncateForDisplay(draft.maxAward.trim())} />
                </code>
              </p>
            ) : null}
          </div>

          {/*
           * Both bounds compare against the derived `nextDeadlineAt`. An entry with no upcoming
           * fixed deadline has a NULL there and is excluded by either — which is why the labels and
           * hints say "fixed" and "rolling" rather than leaving it implicit.
           */}
          <div className={`field${draft.deadlineAfter.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-deadline-after">
              <IconLabel icon={CalendarDaysIcon}>Next fixed deadline after</IconLabel>
            </label>
            <input
              id="directory-deadline-after"
              type="date"
              value={dateInputValue(draft.deadlineAfter)}
              onChange={(event) => setDraft({ ...draft, deadlineAfter: event.target.value })}
            />
            <p className="hint">
              Compares the earliest upcoming fixed deadline. Rolling-only listings, and ones with no
              upcoming fixed deadline, are excluded by this filter.
            </p>
            {/*
             * A link can carry a full instant, which the picker shows as blank — an ACTIVE filter
             * looking like no filter. The exact value stays visible as text, and resubmitting the
             * form untouched still sends it rather than the truncated day.
             */}
            {draft.deadlineAfter.trim() &&
            dateInputValue(draft.deadlineAfter) !== draft.deadlineAfter.trim() ? (
              <p className="hint">
                Filtering on the exact value from the link:{" "}
                <code className="wrap-anywhere">
                  <UntrustedText value={truncateForDisplay(draft.deadlineAfter.trim())} />
                </code>
              </p>
            ) : null}
          </div>

          <div className={`field${draft.deadlineBefore.trim() ? " is-set" : ""}`}>
            <label htmlFor="directory-deadline-before">
              <IconLabel icon={CalendarIcon}>Next fixed deadline before</IconLabel>
            </label>
            <input
              id="directory-deadline-before"
              type="date"
              value={dateInputValue(draft.deadlineBefore)}
              onChange={(event) => setDraft({ ...draft, deadlineBefore: event.target.value })}
            />
            <p className="hint">
              Compares the earliest upcoming fixed deadline. Rolling-only listings, and ones with no
              upcoming fixed deadline, are excluded by this filter.
            </p>
            {/* Length-bounded and `UntrustedText`, same as above: a query param has no limit of
             * its own and this still has to fit the narrowest viewport. */}
            {draft.deadlineBefore.trim() &&
            dateInputValue(draft.deadlineBefore) !== draft.deadlineBefore.trim() ? (
              <p className="hint">
                Filtering on the exact value from the link:{" "}
                <code className="wrap-anywhere">
                  <UntrustedText value={truncateForDisplay(draft.deadlineBefore.trim())} />
                </code>
              </p>
            ) : null}
          </div>

          <div className="field field-action">
            <button type="submit">
              <IconLabel icon={MagnifyingGlassIcon}>Search</IconLabel>
            </button>
          </div>
        </form>
      </search>

      {/*
       * A 400 HERE IS ALWAYS THIS PAGE'S OWN QUERYSTRING, so it gets its own state rather than the
       * generic "we couldn't load" panel: retrying an invalid filter fails the same way every time,
       * and the reader needs to be told WHICH filter is wrong. The endpoint's own message names it.
       */}
      {state.status === "error" && state.error.status === 400 ? (
        <div className="callout state error" role="alert">
          <p className="empty-title">These filters aren&rsquo;t valid.</p>
          <p className="muted">{state.error.message}</p>
          {state.error.issues.length > 0 ? (
            <ul>
              {state.error.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="row">
            <Link href={selectionToHref(DEFAULT_SELECTION)}>Clear the filters</Link>
          </p>
          <TechnicalDetails error={state.error} />
        </div>
      ) : (
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
                <EmptyResult applied={applied} page={list.page} />
              ) : (
                <>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Opportunity</th>
                          <th scope="col">Organization</th>
                          <th scope="col">Type</th>
                          <th scope="col">Status</th>
                          <th scope="col" className="numeric">
                            Deadline
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
                      <IconLabel icon={ChevronLeftIcon}>Previous</IconLabel>
                    </button>
                    <span className="muted">
                      Page {list.page} of {list.totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={list.page >= list.totalPages}
                      onClick={() => commit({ page: list.page + 1 })}
                    >
                      <IconLabel icon={ChevronRightIcon} position="end">
                        Next
                      </IconLabel>
                    </button>
                  </nav>
                </>
              )}
            </>
          )}
        </ResourceView>
      )}
    </>
  );
}

/**
 * "Nothing matches those filters" reads as a fact about the corpus; for an inverted range or a page
 * past the end it is not one. Each also needs a way out that is not "Clear the filters", which
 * would cost a reader who merely paged too far the search that got them there.
 */
function EmptyResult({ applied, page }: { applied: DirectorySelection; page: number }) {
  const filtered = isFiltered(applied);
  const pastEnd = page > 1;
  const hints = emptyResultHints(applied);

  return (
    <EmptyState
      // A page past the end is why THIS page is empty, whatever the filters are doing, so it owns
      // the title: "nothing matches those filters" is about the result, not about page 9 of it.
      title={
        pastEnd
          ? `Page ${page} is past the end of this result.`
          : filtered
            ? "Nothing matches those filters."
            : "Nothing published yet."
      }
      detail={
        hints.length > 0
          ? hints.join(" ")
          : filtered
            ? "Funding type and status match exactly; the search box matches words in the title, summary and description."
            : "This directory lists opportunities a reviewer has approved and listed. There are none yet."
      }
      action={
        <>
          {pastEnd ? (
            <Link href={selectionToHref({ ...applied, page: 1 })}>Back to page 1</Link>
          ) : null}
          {filtered ? (
            <Link href={selectionToHref(DEFAULT_SELECTION)}>Clear the filters</Link>
          ) : null}
          <Link href={HOW_IT_WORKS}>Do you run a program?</Link>
        </>
      }
    />
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
 * `operatingOrganizations` is a required, order-significant array whose entry 0 is the organization
 * to display — the party that actually runs the intake. Sponsors are a different array and are left
 * to the detail page: naming a backer in a column headed "Organization" would misattribute who a
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
  const typeLabel = fundingTypeLabel(item.fundingType);
  return (
    <tr>
      <th scope="row">
        <div className="opportunity-cell">
          <span className="opportunity-type-icon" title={typeLabel} aria-hidden="true">
            <DecorativeIcon icon={FUNDING_TYPE_ICONS[item.fundingType]} />
          </span>
          <div className="opportunity-cell-copy">
            <Link href={`/opportunities/${encodeURIComponent(item.id)}`} className="row-title">
              <UntrustedText value={item.title} />
            </Link>
            {item.summary?.trim() ? (
              <div className="row-summary">
                <UntrustedText value={item.summary} />
              </div>
            ) : null}
          </div>
        </div>
      </th>
      <td className="muted">
        <UntrustedText value={operator?.name} />
      </td>
      <td>{typeLabel}</td>
      <td>
        <StatusBadge status={item.status} />
      </td>
      <td className="numeric">{describeDirectoryDeadline(item.deadlines)}</td>
    </tr>
  );
}
