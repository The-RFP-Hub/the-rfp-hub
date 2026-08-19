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
 * THE LEDE IS TWO SENTENCES AND THE SECOND ONE IS A DISCLAIMER, deliberately, above the fold and in
 * the same type size as the promise. What this site is gets one line; what it is NOT — an
 * application portal — gets the next, because the misunderstanding it prevents is the expensive
 * one. A reader who thinks they applied here has not applied anywhere.
 *
 * The sign-in card has not been removed, only demoted: it sits below the directory, and "Log in"
 * stays in the header where it has always been. `/dashboard` is the publisher's own surface and is
 * where the signed-in overview moved to.
 */
import { DirectoryList } from "@/components/DirectoryList";
import { AuthUnavailable, Loading } from "@/components/states";
import { HOW_IT_WORKS } from "@/lib/links";
import { useSession } from "@/lib/session";
import Link from "next/link";
import { Suspense } from "react";

export default function DirectoryPage() {
  return (
    <section>
      <h1>Funding opportunities</h1>
      <p className="lede">
        An open, neutral index of funding in the Ethereum ecosystem — grants, hackathons, bounties,
        RFPs. <strong>Free to read, no account.</strong>
        <br />
        We link you to each programme&rsquo;s own application page;{" "}
        <strong>we never take applications ourselves</strong>.
      </p>

      {/*
       * The filter state lives in `searchParams`, which a client component may only read inside a
       * Suspense boundary — the framework needs somewhere to put the fallback while it resolves
       * them. The fallback is the same loading state the directory would show anyway, so the
       * boundary costs a reader nothing.
       */}
      <Suspense fallback={<Loading what="the directory" />}>
        <DirectoryList />
      </Suspense>

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
        Submit your opportunities, keep them current, and see what they get read and applied for.
        Signing in creates an account the first time; publishing without review additionally
        requires membership of a verified organisation, which a reviewer grants.{" "}
        <Link href={HOW_IT_WORKS}>Who can do what</Link> sets out the whole of it.
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
            <button type="button" className="button-primary" onClick={session.login}>
              Log in
            </button>
          </p>
          <p className="muted footnote">
            Signing in is a one-time code emailed to you by this service. There is no password to
            choose or lose and no key to hand over; the code is exchanged for a token kept in this
            browser and sent to the API, which is the only thing that decides what an account may
            do.
          </p>
        </>
      )}
    </section>
  );
}
