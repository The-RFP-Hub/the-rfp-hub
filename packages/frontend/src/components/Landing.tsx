"use client";

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
import { OpportunityCard } from "@/components/OpportunityCard";
import { ResourceView } from "@/components/states";
import { DEFAULT_SELECTION, selectionToHref } from "@/lib/directory";
import { formatCount } from "@/lib/format";
import { type LandingSummary, TILE_TYPES, compactUsd, summarizeLanding } from "@/lib/landing";
import { DIRECTORY, HOW_IT_WORKS } from "@/lib/links";
import { loadOpenSet } from "@/lib/open-set";
import { fundingTypeLabel } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi, useSession } from "@/lib/session";
import type { FundingType } from "@/lib/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useState } from "react";

const TILE_COPY: Readonly<Record<FundingType, string>> = {
  grant: "Rolling and dated programs",
  hackathon: "In person and online",
  bounty: "Security, paid by severity",
  rfp: "They know what they want",
  accelerator: "",
  vc_fund: "",
};

export function Landing() {
  const api = useApi();

  const load = useCallback(async () => summarizeLanding(await loadOpenSet(api)), [api]);
  const { state, reload } = useResource(load);

  return (
    <div className="landing">
      <Hero summary={state.status === "ready" ? state.data : null} apiBaseUrl={api.baseUrl} />
      <ResourceView resource={state} what="the index" onRetry={reload}>
        {(summary) => (
          <>
            <ClosingSoon summary={summary} />
            <TypeTiles summary={summary} />
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
  );
}

function Hero({ summary, apiBaseUrl }: { summary: LandingSummary | null; apiBaseUrl: string }) {
  const session = useSession();
  const router = useRouter();
  const [q, setQ] = useState("");

  const search = (event: FormEvent) => {
    event.preventDefault();
    router.push(selectionToHref({ ...DEFAULT_SELECTION, q: q.trim() }));
  };

  const publishHref = session.authenticated ? "/listings/new" : `${HOW_IT_WORKS}#publish`;

  return (
    <section className="landing-hero" aria-labelledby="landing-heading">
      <div className="landing-hero-copy">
        <p className="landing-position">An open index. Not an application portal.</p>
        <h1 id="landing-heading">
          Find what&rsquo;s open on Ethereum: grants, hackathons, bounties, RFPs.
        </h1>
        <p className="lede">
          Every listing links out to the program&rsquo;s own site. You apply there.
        </p>

        <div className="landing-paths">
          <Link className="landing-path" href={DIRECTORY}>
            <span className="landing-path-title">I&rsquo;m looking for funding →</span>
            <span className="landing-path-note">
              {summary
                ? `Browse ${formatCount(summary.open)} open opportunities`
                : "Browse the directory"}
            </span>
          </Link>
          <Link className="landing-path landing-path-publish" href={publishHref}>
            <span className="landing-path-title">I publish a program →</span>
            <span className="landing-path-note">
              Log in, submit a listing, and a verified organization publishes instantly
            </span>
          </Link>
        </div>

        <search>
          <form className="landing-search" onSubmit={search}>
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
            <button type="submit">Search</button>
          </form>
        </search>

        <p className="landing-data muted">
          Open data
          <a href={`${apiBaseUrl}/v1/export/opportunities.json`}>JSON</a>
          <a href={`${apiBaseUrl}/v1/export/opportunities.csv`}>CSV</a>
          <a href={`${apiBaseUrl}/v1/feeds/opportunities.rss`}>RSS</a>
          <span>CC0, updated nightly</span>
        </p>
      </div>

      <dl className="landing-tally" aria-label="The index at a glance">
        <TallyRow value={summary ? formatCount(summary.open) : "—"} unit="open opportunities">
          across grants, hackathons, bounties and RFPs
        </TallyRow>
        <TallyRow
          value={summary ? compactUsd(summary.awardsUsd) : "—"}
          unit="in maximum awards listed"
        >
          {summary
            ? `summed from the ${formatCount(summary.awardsCounted)} listings that state a USD amount`
            : "summed from listings that state a USD amount"}
        </TallyRow>
        <TallyRow value={summary ? formatCount(summary.organizations) : "—"} unit="organizations">
          running at least one open program
        </TallyRow>
        <TallyRow
          value={summary ? formatCount(summary.closingSoonTotal) : "—"}
          unit="closing in the next 30 days"
          hot
        >
          {summary && summary.closingSoon.length > 0
            ? summary.closingSoon
                .slice(0, 4)
                .map((item) => item.title)
                .join(", ")
            : "Only fixed deadlines. Rolling programs stay open."}
        </TallyRow>
      </dl>
    </section>
  );
}

function TallyRow({
  value,
  unit,
  hot,
  children,
}: {
  value: string;
  unit: string;
  hot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`landing-tally-row${hot ? " is-hot" : ""}`}>
      <dt>
        <span className="landing-tally-value">{value}</span>
        <span className="visually-hidden"> </span>
        <span className="landing-tally-unit">{unit}</span>
      </dt>
      <dd className="landing-tally-why">{children}</dd>
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

function TypeTiles({ summary }: { summary: LandingSummary }) {
  const other = Object.entries(summary.byType)
    .filter(([type]) => !TILE_TYPES.includes(type as FundingType))
    .reduce((sum, [, count]) => sum + count, 0);
  return (
    <section className="landing-block" aria-labelledby="types-heading">
      <div className="landing-block-head">
        <h2 id="types-heading">Browse by type</h2>
        {other > 0 ? (
          <Link href={DIRECTORY}>
            plus {formatCount(other)} accelerator{other === 1 ? "" : "s"} and funds →
          </Link>
        ) : null}
      </div>
      <ul className="plain landing-tiles">
        {TILE_TYPES.map((type) => (
          <li key={type}>
            <Link
              className="landing-tile"
              data-type={type}
              href={selectionToHref({ ...DEFAULT_SELECTION, fundingType: type })}
            >
              <span className="landing-tile-count">{formatCount(summary.byType[type] ?? 0)}</span>
              <span className="landing-tile-label">
                {type === "rfp" ? "RFPs" : `${fundingTypeLabel(type)}s`}
                <span className="landing-tile-note">{TILE_COPY[type]}</span>
              </span>
            </Link>
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
        <span className="muted footnote">ranked by the stated ceiling, nothing else</span>
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
