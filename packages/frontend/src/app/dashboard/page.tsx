"use client";

/**
 * The publisher's own front door: sign in, then this account's traffic across everything it
 * publishes.
 *
 * This was `/` until the public directory took that route. Nothing about it changed except the
 * address and the framing — the directory is what a visitor came for, and this is what a publisher
 * came for, so they are two pages rather than one page with a wall in front of it.
 *
 * The signed-out half still explains what an account is FOR before asking for one. A login wall with
 * a bare button tells a publisher nothing about why they should click it.
 */
import { UntrustedText } from "@/components/UntrustedText";
import { AuthUnavailable, ResourceView } from "@/components/states";
import { METRIC_LABELS, formatCount, formatDay } from "@/lib/format";
import { HOW_IT_WORKS } from "@/lib/links";
import { DASHBOARD_GATE_COPY } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi, useSession } from "@/lib/session";
import Link from "next/link";
import { useCallback } from "react";

export default function DashboardPage() {
  const session = useSession();

  if (session.error) return <AuthUnavailable error={session.error} />;
  if (!session.ready) {
    return <p className="state">Restoring your session…</p>;
  }

  if (!session.authenticated) {
    return (
      <section>
        <h1>{DASHBOARD_GATE_COPY.title}</h1>
        <p className="lede">{DASHBOARD_GATE_COPY.detail}</p>
        <p className="footnote">
          Submit funding opportunities to the RFP Hub, keep them current, and see what they get read
          and applied for. Signing in creates an account the first time; publishing without review
          additionally requires membership of a verified organisation, which a reviewer grants —{" "}
          <Link href={HOW_IT_WORKS}>who can do what</Link> sets out the whole of it.
        </p>
        <p>
          <button type="button" className="button-primary" onClick={session.login}>
            Log in
          </button>
        </p>
        <p className="muted footnote">
          Signing in is a one-time code emailed to you by this service. There is no password to
          choose or lose and no key to hand over. This browser stores a session so you can manage
          your account. Permissions are checked when you submit or manage a listing.
        </p>
        <p className="muted footnote">
          Nothing here is needed to read the Hub — <Link href="/">the directory</Link> is public.
        </p>
      </section>
    );
  }

  return <Overview />;
}

function Overview() {
  const api = useApi();
  const load = useCallback(() => api.insights.summary(30), [api]);
  const { state, reload } = useResource(load);

  return (
    <section>
      <div className="row-between">
        <h1>Dashboard</h1>
        <Link className="button-primary" href="/listings/new">
          Submit an opportunity
        </Link>
      </div>
      <h2>Listings traffic</h2>
      <ResourceView resource={state} what="your traffic summary" onRetry={reload}>
        {(summary) => (
          <>
            <p className="muted">
              {formatDay(summary.from)} to {formatDay(summary.to)} · best-effort, server-side counts
            </p>
            <ul className="kpi-grid">
              {(["listViews", "detailViews", "sourceClicks", "applyClicks"] as const).map((key) => (
                <li key={key} className="tile card">
                  <span className="tile-value">{formatCount(summary.totals[key])}</span>
                  <span className="tile-label">{METRIC_LABELS[key]}</span>
                </li>
              ))}
            </ul>

            {summary.opportunities.length === 0 ? (
              <div className="state empty">
                <p className="empty-title">No published listings to measure yet.</p>
                <p className="muted">
                  Traffic starts after a listing reaches the public directory. Pending listings are
                  not public and produce no traffic here.
                </p>
                <p className="row">
                  <Link href="/listings/new">Submit an opportunity</Link>
                  <span className="muted">
                    It lands pending unless your account publishes into a verified namespace.
                  </span>
                </p>
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <caption>Most-read listings first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Listing</th>
                      <th scope="col" className="numeric">
                        Detail views
                      </th>
                      <th scope="col" className="numeric">
                        Apply clicks
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.opportunities.map((entry) => (
                      <tr key={entry.opportunityId}>
                        <th scope="row">
                          <Link href={`/listings/${encodeURIComponent(entry.opportunityId)}`}>
                            <UntrustedText value={entry.title} />
                          </Link>
                          <div className="muted">
                            <code>{entry.opportunityId}</code>
                          </div>
                        </th>
                        <td className="numeric">{formatCount(entry.detailViews)}</td>
                        <td className="numeric">{formatCount(entry.applyClicks)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </ResourceView>
    </section>
  );
}
