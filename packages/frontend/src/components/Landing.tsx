"use client";

import { OpportunityCard } from "@/components/OpportunityCard";
import { TypePills } from "@/components/TypePills";
import { ResourceView } from "@/components/states";
import { DEFAULT_SELECTION, selectionToHref } from "@/lib/directory";
import { formatCount } from "@/lib/format";
import { type LandingSummary, compactUsd, summarizeLanding } from "@/lib/landing";
import { DIRECTORY } from "@/lib/links";
import { loadOpenSet } from "@/lib/open-set";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
/**
 * THE FRONT PAGE IS A PITCH FOR THE INDEX, and the index itself lives at `/directory`.
 *
 * Somebody who already uses the site goes straight to the directory. Somebody arriving from a talk,
 * a QR code or a link needs three things first: what this is, proof that it is alive, and the two
 * ways in. So the hero is a headline, a tally of real numbers, and two doors, with search under
 * them rather than in place of them.
 *
 * EVERY NUMBER IS DERIVED FROM THE OPEN SET, fetched through the same unauthenticated list route the
 * directory reads. Nothing is hand-entered and nothing is an estimate: `lib/landing.ts` does the
 * arithmetic and a unit test pins it. The open set is small (about a hundred) so it fits in one or
 * two pages of the list route; the loop below stops at a hard cap either way.
 */
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useState } from "react";

export function Landing() {
  const api = useApi();

  const load = useCallback(async () => summarizeLanding(await loadOpenSet(api)), [api]);
  const { state, reload } = useResource(load);

  return (
    <div className="landing">
      <Hero summary={state.status === "ready" ? state.data : null} />
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

function Hero({ summary }: { summary: LandingSummary | null }) {
  const router = useRouter();
  const [q, setQ] = useState("");

  const search = (event: FormEvent) => {
    event.preventDefault();
    router.push(selectionToHref({ ...DEFAULT_SELECTION, q: q.trim() }));
  };

  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-heading">
        <HeroDecor />
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
 * Decorative: faint concentric arcs with a few funders' marks resting on them, at the hero's edges.
 * Every mark belongs to an organization with an open listing in the index and is the organization's
 * own artwork in its own colours (see `public/hero-logos/`). Hidden from assistive tech and on
 * narrow screens. The positions sit on the arcs, which share the frame's 1240 × 440 coordinate space.
 */
const HERO_MARKS = ["ethereum", "uniswap", "chainlink", "morpho", "optimism", "ens"] as const;

function HeroDecor() {
  return (
    <div className="landing-decor" aria-hidden="true">
      <svg viewBox="0 0 1240 440" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <circle cx="620" cy="220" r="450" />
        <circle cx="620" cy="220" r="570" />
      </svg>
      {HERO_MARKS.map((mark) => (
        <span key={mark} className="landing-mark-tile" data-mark={mark}>
          <span className="landing-mark-logo" />
        </span>
      ))}
    </div>
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
