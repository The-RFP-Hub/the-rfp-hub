"use client";

import { OpportunityCard } from "@/components/OpportunityCard";
import { TypePills } from "@/components/TypePills";
import { UntrustedText } from "@/components/UntrustedText";
import { ResourceView } from "@/components/states";
import { DEFAULT_SELECTION, selectionToHref } from "@/lib/directory";
import { formatCount } from "@/lib/format";
import {
  type LandingSummary,
  awardParts,
  awardScale,
  cardAward,
  compactUsd,
  handDate,
  summarizeLanding,
} from "@/lib/landing";
import { DIRECTORY } from "@/lib/links";
import { loadOpenSet } from "@/lib/open-set";
import { fundingTypeChipLabel, joinOrganizationNames } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { OpportunitySummary } from "@/lib/types";
/**
 * THE FRONT PAGE IS A PITCH FOR THE INDEX, and the index itself lives at `/directory`.
 *
 * Somebody who already uses the site goes straight to the directory. Somebody arriving from a talk,
 * a QR code or a link needs three things first: what this is, proof that it is alive, and the ways
 * in. So the hero is a headline with search and the type pills beside three real open listings, one
 * grant, one hackathon and one bounty, and a tally of real numbers under both.
 *
 * EVERY NUMBER IS DERIVED FROM THE OPEN SET, fetched through the same unauthenticated list route the
 * directory reads. Nothing is hand-entered and nothing is an estimate: `lib/landing.ts` does the
 * arithmetic and a unit test pins it. The open set is small (about a hundred) so it fits in one or
 * two pages of the list route; the loop below stops at a hard cap either way.
 */
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type CSSProperties, type FormEvent, useCallback, useState } from "react";

export function Landing() {
  const api = useApi();

  const load = useCallback(async () => summarizeLanding(await loadOpenSet(api)), [api]);
  const { state, reload } = useResource(load);

  return (
    <div className="landing">
      <Hero
        summary={state.status === "ready" ? state.data : null}
        loading={state.status === "idle" || state.status === "loading"}
      />
      <div className="landing-body">
        <ResourceView resource={state} what="the index" onRetry={reload}>
          {(summary) => (
            <>
              <ClosingSoon summary={summary} />
              <Featured summary={summary} />
              <p className="landing-all">
                <Link className="button-primary" href={DIRECTORY}>
                  See all {formatCount(summary.open)} open opportunities →
                </Link>
              </p>
            </>
          )}
        </ResourceView>
      </div>
    </div>
  );
}

function Hero({ summary, loading }: { summary: LandingSummary | null; loading: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");

  const search = (event: FormEvent) => {
    event.preventDefault();
    router.push(selectionToHref({ ...DEFAULT_SELECTION, q: q.trim() }));
  };

  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-heading">
        <div className="landing-hero-copy">
          <h1 id="landing-heading">Find funding across the Ethereum ecosystem</h1>
          <p className="landing-sub">
            Open grants, hackathons, bounties and RFPs from organizations supporting Ethereum.
          </p>

          <search>
            <form className="landing-search" onSubmit={search}>
              <MagnifyingGlassIcon className="landing-search-icon" aria-hidden="true" />
              <label htmlFor="landing-q" className="visually-hidden">
                Search the directory
              </label>
              <input
                id="landing-q"
                type="search"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Search by topic, org or city…"
              />
              <button type="submit" className="button-primary">
                Search
              </button>
            </form>
          </search>

          <TypePills
            selected=""
            counts={summary?.byType ?? null}
            showAll={false}
            onPick={(fundingType) =>
              router.push(selectionToHref({ ...DEFAULT_SELECTION, fundingType }))
            }
          />
        </div>

        <Hand summary={summary} loading={loading} />
      </section>

      <dl className="landing-tally" aria-label="The index at a glance">
        <TallyItem value={summary ? formatCount(summary.open) : "—"} unit="Open opportunities" />
        <TallyItem value={summary ? compactUsd(summary.awardsUsd) : "—"} unit="In max awards" />
        <TallyItem
          value={summary ? formatCount(summary.organizations) : "—"}
          unit="Organizations"
        />
        <TallyItem
          value={summary ? formatCount(summary.closingSoonTotal) : "—"}
          unit="Closing in 30 days"
        />
      </dl>
    </>
  );
}

/**
 * Three real listings dealt beside the search: one open grant, hackathon and bounty, chosen by
 * `dealHand`'s rule. Each card is a link to its listing and leads with the amount, set larger the
 * larger the award. While the open set loads the slot says so; if it fails, the error below the
 * hero speaks for the page and the slot stays empty.
 */
function Hand({ summary, loading }: { summary: LandingSummary | null; loading: boolean }) {
  if (!summary) {
    return loading ? <p className="landing-hand-wait muted">Loading listings…</p> : null;
  }
  if (summary.hand.length === 0) return null;
  // On a phone the hand is a row you swipe, and the card worth the most leads it.
  const scales = summary.hand.map(awardScale);
  const lead = scales.indexOf(Math.max(...scales));
  return (
    <ul className="landing-hand" aria-label="One open grant, hackathon and bounty">
      {summary.hand.map((item, index) => (
        <li key={item.id} data-slot={index} data-lead={index === lead ? "" : undefined}>
          <HandCard item={item} />
        </li>
      ))}
    </ul>
  );
}

function HandCard({ item }: { item: OpportunitySummary }) {
  const award = cardAward(item);
  const parts = award ? awardParts(award) : null;
  const when = handDate(item);
  return (
    <Link
      className="landing-card"
      href={`/opportunities/${encodeURIComponent(item.id)}`}
      style={{ "--award-scale": awardScale(item) } as CSSProperties}
    >
      <span className="landing-card-top">
        <span className="type-chip" data-type={item.fundingType}>
          {fundingTypeChipLabel(item.fundingType)}
        </span>
        {when ? <span className="landing-card-when">{when}</span> : null}
      </span>
      <span className="landing-card-title">
        <UntrustedText value={item.title} />
      </span>
      <span className="landing-card-org">
        <UntrustedText
          value={joinOrganizationNames(item.operatingOrganizations.map((org) => org.name))}
        />
      </span>
      {parts ? (
        <span className="landing-card-award">
          {parts.before ? <span className="landing-card-word">{parts.before} </span> : null}
          <span className="landing-card-figure">{parts.figure}</span>
          {parts.after ? <span className="landing-card-word"> {parts.after}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}

function TallyItem({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="landing-tally-item">
      <dt className="landing-tally-unit">{unit}</dt>
      <dd className="landing-tally-value">{value}</dd>
    </div>
  );
}

function ClosingSoon({ summary }: { summary: LandingSummary }) {
  if (summary.closingSoon.length === 0) return null;
  return (
    <section className="landing-block" aria-labelledby="closing-heading">
      <div className="landing-block-head">
        <h2 id="closing-heading">Closing soon</h2>
        <Link href={selectionToHref({ ...DEFAULT_SELECTION, ordering: "nextDeadlineAt:asc" })}>
          All by deadline →
        </Link>
      </div>
      <ul className="plain landing-strip">
        {summary.closingSoon.map((item) => (
          <li key={item.id}>
            <OpportunityCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Featured({ summary }: { summary: LandingSummary }) {
  if (summary.featured.length === 0) return null;
  return (
    <section className="landing-block" aria-labelledby="featured-heading">
      <div className="landing-block-head">
        <h2 id="featured-heading">Largest open awards</h2>
      </div>
      <ul className="plain landing-featured">
        {summary.featured.map((item) => (
          <li key={item.id}>
            <OpportunityCard item={item} large />
          </li>
        ))}
      </ul>
    </section>
  );
}
