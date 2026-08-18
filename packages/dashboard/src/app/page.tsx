"use client";

/**
 * THE FRONT DOOR IS THE DIRECTORY, not a login wall.
 *
 * Until this page existed, an anonymous visitor to this deployment saw one thing: a button asking
 * them to sign in to a publisher dashboard. That is the wrong first screen for a public register of
 * funding opportunities — the people the data is FOR are applicants, and an applicant has no reason
 * to hold an account here at all. The reads behind this page are unauthenticated, so there was never
 * a technical reason for the wall either.
 *
 * The sign-in card has not been removed, only demoted: it sits below the directory, and "Log in"
 * stays in the header where it has always been. `/dashboard` is the publisher's own surface and is
 * where the signed-in overview moved to.
 */
import { DirectoryList } from "@/components/DirectoryList";
import { AuthUnavailable } from "@/components/states";
import { useSession } from "@/lib/session";
import Link from "next/link";

export default function DirectoryPage() {
  return (
    <section>
      <h1>Funding opportunities</h1>
      <p className="footnote">
        Every entry a reviewer has approved and listed, republished in one place under a single open
        standard. Reading it needs no account: search, open an entry and follow it through to the
        programme&rsquo;s own application page.
      </p>

      <DirectoryList />

      <PublisherInvitation />
    </section>
  );
}

/**
 * The demoted half of the old landing page.
 *
 * It still has to say what an account is FOR before asking for one — a bare login button tells a
 * publisher nothing about why they should click it — but it says it after the thing most visitors
 * came for, not instead of it.
 */
function PublisherInvitation() {
  const session = useSession();

  if (session.error) return <AuthUnavailable error={session.error} />;

  return (
    <section className="card" aria-labelledby="publish-heading">
      <h2 id="publish-heading">Do you run one of these programmes?</h2>
      <p className="footnote">
        The workbench is the other half of this site: submit opportunities, keep them current, and
        see what they get read and applied for. Signing in creates an account the first time;
        publishing without review additionally requires membership of a verified organisation, which
        a reviewer grants.
      </p>
      {!session.ready ? (
        <p className="muted">Restoring your session…</p>
      ) : session.authenticated ? (
        <p>
          <Link href="/dashboard">Open your dashboard</Link>
        </p>
      ) : (
        <>
          <p>
            <button type="button" onClick={session.login}>
              Log in
            </button>
          </p>
          <p className="muted footnote">
            Authentication is handled by an external provider. This site never sees a password or a
            private key: it exchanges the session for a short-lived access token and sends that to
            the API, which is the only thing that decides what an account may do.
          </p>
        </>
      )}
    </section>
  );
}
