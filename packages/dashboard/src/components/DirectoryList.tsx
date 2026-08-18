"use client";

/**
 * The public directory: every PUBLISHED opportunity, as a visitor with no account reads it.
 *
 * NO SESSION IS INVOLVED, and that is the point. `GET /v1/opportunities` is unauthenticated, the API
 * client attaches an `Authorization` header only when there is a token to attach, and this component
 * never asks for one — so it renders identically for a signed-in publisher and for somebody who has
 * never seen this deployment before. A signed-in reader is not shown more here: the route serves
 * `approved AND is_listed` entries and nothing else, whoever asks.
 *
 * EVERY FILTER IS A PARAMETER THE ENDPOINT DECLARES. The list route validates its querystring with
 * `additionalProperties: false`, so an invented filter is a 400 rather than a control that quietly
 * does nothing; `lib/directory.ts` builds the query and is unit-tested for exactly that. The filter
 * values themselves are read out of the Standard's schema, so the six funding types and four
 * statuses offered here cannot drift from the ones the API accepts.
 *
 * The list payload is the thin projection — a Standard opportunity minus `fundingDetails` — so the
 * columns below are all fields it actually carries. `deadlines[]` is an array of fixed and rolling
 * entries rather than a single date, and the next-deadline phrase is derived from it exactly as the
 * API derives the key it sorts on.
 */
import { UntrustedText } from "@/components/UntrustedText";
import { EmptyState, ResourceView } from "@/components/states";
import {
  DEFAULT_SELECTION,
  type DirectorySelection,
  FUNDING_TYPES,
  ORDERINGS,
  type Ordering,
  STATUSES,
  directoryQuery,
  isFiltered,
} from "@/lib/directory";
import { describeAward, describeDeadline, formatCount } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { OpportunitySummary } from "@/lib/types";
import Link from "next/link";
import { type FormEvent, useCallback, useState } from "react";

export function DirectoryList() {
  const api = useApi();
  const [selection, setSelection] = useState<DirectorySelection>(DEFAULT_SELECTION);
  // The two free-text filters are applied on submit rather than per keystroke: there is no
  // debounce in this package, and a request per character would be one per character.
  const [q, setQ] = useState("");
  const [ecosystem, setEcosystem] = useState("");

  const load = useCallback(() => api.directory.list(directoryQuery(selection)), [api, selection]);
  const { state, reload } = useResource(load);

  /** Any change to a filter returns to page 1 — page 4 of the previous result is not page 4 of this one. */
  const apply = (patch: Partial<DirectorySelection>) =>
    setSelection((current) => ({ ...current, ...patch, page: 1 }));

  const search = (event: FormEvent) => {
    event.preventDefault();
    apply({ q, ecosystem });
  };

  return (
    <>
      <form className="filters" onSubmit={search}>
        <div className="field">
          <label htmlFor="directory-q">Search</label>
          <input
            id="directory-q"
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Words in the title, summary or description"
          />
        </div>

        <div className="field">
          <label htmlFor="directory-ecosystem">Ecosystem</label>
          <input
            id="directory-ecosystem"
            value={ecosystem}
            onChange={(event) => setEcosystem(event.target.value)}
            placeholder="Exactly as the publisher named it"
          />
        </div>

        <div className="field">
          <label htmlFor="directory-type">Funding type</label>
          <select
            id="directory-type"
            value={selection.fundingType}
            onChange={(event) => apply({ fundingType: event.target.value })}
          >
            <option value="">Any</option>
            {FUNDING_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="directory-status">Status</label>
          <select
            id="directory-status"
            value={selection.status}
            onChange={(event) => apply({ status: event.target.value })}
          >
            <option value="">Any</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="directory-order">Order</label>
          <select
            id="directory-order"
            value={selection.ordering}
            onChange={(event) => apply({ ordering: event.target.value as Ordering })}
          >
            {ORDERINGS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <button type="submit">Search</button>
        </div>
      </form>

      <ResourceView resource={state} what="the directory" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title={
                isFiltered(selection) ? "Nothing matches those filters." : "Nothing published yet."
              }
              detail={
                isFiltered(selection)
                  ? "Ecosystem and funding type match exactly; the search box matches words in the title, summary and description."
                  : "This directory lists entries a reviewer has approved and listed. There are none yet."
              }
            />
          ) : (
            <>
              <table>
                <caption>
                  {formatCount(list.total)} published{" "}
                  {list.total === 1 ? "opportunity" : "opportunities"} · page {list.page} of{" "}
                  {list.totalPages}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Opportunity</th>
                    <th scope="col">Organisation</th>
                    <th scope="col">Next deadline</th>
                    <th scope="col">Award</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((item) => (
                    <DirectoryRow key={item.id} item={item} />
                  ))}
                </tbody>
              </table>

              <div className="row">
                <button
                  type="button"
                  disabled={list.page <= 1}
                  onClick={() => setSelection((current) => ({ ...current, page: list.page - 1 }))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={list.page >= list.totalPages}
                  onClick={() => setSelection((current) => ({ ...current, page: list.page + 1 }))}
                >
                  Next
                </button>
              </div>
            </>
          )
        }
      </ResourceView>
    </>
  );
}

/**
 * One row.
 *
 * `operatingOrganizations` is a required, order-significant array whose entry 0 is the organisation
 * to display — the party that actually runs the intake. Sponsors are a different array and are left
 * to the detail page: naming a backer in a column headed "Organisation" would misattribute who a
 * reader is applying to.
 */
export function DirectoryRow({ item }: { item: OpportunitySummary }) {
  const operator = item.operatingOrganizations[0];
  const award = describeAward(item.fundingInfo);
  return (
    <tr>
      <th scope="row">
        <Link href={`/opportunities/${encodeURIComponent(item.id)}`}>
          <UntrustedText value={item.title} />
        </Link>
        <div className="muted">
          <code>{item.id}</code> · {item.fundingType} · {item.status}
        </div>
        {item.ecosystems && item.ecosystems.length > 0 ? (
          <div className="muted">
            <UntrustedText value={item.ecosystems.join(", ")} />
          </div>
        ) : null}
      </th>
      <td>
        <UntrustedText value={operator?.name} />
      </td>
      <td>{describeDeadline(item.deadlines)}</td>
      <td>{award ? <UntrustedText value={award} /> : <span className="muted">—</span>}</td>
    </tr>
  );
}
