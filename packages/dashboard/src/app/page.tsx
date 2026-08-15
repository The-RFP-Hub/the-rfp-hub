"use client";

/**
 * The front door: sign in, then the account's own traffic across everything it publishes.
 *
 * The signed-out half explains what an account is FOR before asking for one. A login wall with a
 * bare button tells a publisher nothing about why they should click it.
 */
import { UntrustedText } from "@/components/UntrustedText";
import { AuthUnavailable, ResourceView } from "@/components/states";
import { METRIC_LABELS, formatCount, formatDay } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi, useSession } from "@/lib/session";
import Link from "next/link";
import { useCallback } from "react";

export default function HomePage() {
  const session = useSession();

  if (session.error) return <AuthUnavailable error={session.error} />;
  if (!session.ready) {
    return <p className="state">Restoring your session…</p>;
  }

  if (!session.authenticated) {
    return (
      <section>
        <h1>Publisher dashboard</h1>
        <p className="footnote">
          Submit funding opportunities to the RFP Hub, keep them current, and see what they get read
          for. Signing in creates an account the first time; publishing without review additionally
          requires membership of a verified organisation, which a reviewer grants.
        </p>
        <p>
          <button type="button" onClick={session.login}>
            Log in
          </button>
        </p>
        <p className="muted footnote">
          Authentication is handled by an external provider. This dashboard never sees a password or
          a private key: it exchanges the session for a short-lived access token and sends that to
          the API, which is the only thing that decides what an account may do.
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
      <h1>Your entries</h1>
      <ResourceView resource={state} what="your traffic summary" onRetry={reload}>
        {(summary) => (
          <>
            <p className="muted">
              {formatDay(summary.from)} to {formatDay(summary.to)} · best-effort, server-side counts
            </p>
            <ul className="tiles">
              {(["listViews", "detailViews", "sourceClicks", "applyClicks"] as const).map((key) => (
                <li key={key} className="tile card">
                  <span className="tile-value">{formatCount(summary.totals[key])}</span>
                  <span className="tile-label">{METRIC_LABELS[key]}</span>
                </li>
              ))}
            </ul>

            {summary.opportunities.length === 0 ? (
              <div className="state empty">
                <p className="empty-title">Nothing published under this account yet.</p>
                <p className="muted">
                  <Link href="/listings/new">Submit an opportunity</Link> — it will land pending
                  unless your account publishes into a verified namespace.
                </p>
              </div>
            ) : (
              <table>
                <caption>Most-read entries first</caption>
                <thead>
                  <tr>
                    <th scope="col">Entry</th>
                    <th scope="col">Detail views</th>
                    <th scope="col">Apply clicks</th>
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
                      <td>{formatCount(entry.detailViews)}</td>
                      <td>{formatCount(entry.applyClicks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </ResourceView>
    </section>
  );
}
