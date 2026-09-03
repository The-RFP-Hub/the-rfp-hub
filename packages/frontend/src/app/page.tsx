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
import { NoScriptNotice } from "@/components/NoScriptNotice";
import { AuthUnavailable, Loading } from "@/components/states";
import { GOVERNANCE, HOW_IT_WORKS, REVIEW_CRITERIA } from "@/lib/links";
import { useSession } from "@/lib/session";
import Link from "next/link";
import { Suspense } from "react";

export default function DirectoryPage() {
  return (
    <section>
      <h1>Funding opportunities</h1>
      <p className="lede">
        Browse grants, hackathons, bounties and RFPs across the Ethereum ecosystem. Free to read;
        applications stay on each program&rsquo;s own site.
      </p>

      <NoScriptNotice />

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

  return (
    <section className="card" aria-labelledby="publish-heading">
      <h2 id="publish-heading">Do you run one of these programs?</h2>
      <p className="footnote">
        Submit your opportunities, keep them current, and see what they get read and applied for.
        Signing in creates an account the first time; publishing without review additionally
        requires membership of a verified organization, which a reviewer grants.{" "}
        <Link href={HOW_IT_WORKS}>Who can do what</Link> sets out the whole of it.
      </p>
      {/*
       * The governance link belongs on the page, not only in the global footer: what a listing is
       * checked against, and who may change that, is the first thing a publisher deciding whether
       * to submit here needs to be able to read. It sits above the session branch so that it is
       * still there when sign-in itself is unavailable.
       */}
      <p className="footnote">
        The rules are public and so is the appeal against one:{" "}
        <a href={GOVERNANCE} target="_blank" rel="noopener noreferrer">
          Governance
        </a>{" "}
        sets out who decides and how to disagree, and{" "}
        <a href={REVIEW_CRITERIA} target="_blank" rel="noopener noreferrer">
          Review criteria
        </a>{" "}
        sets out what one listing is checked against before it publishes.
      </p>
      {session.error ? (
        <AuthUnavailable error={session.error} />
      ) : !session.ready ? (
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
            choose or lose and no key to hand over. This browser stores a session so you can manage
            your account. Permissions are checked when you submit or manage a listing.
          </p>
        </>
      )}
    </section>
  );
}
