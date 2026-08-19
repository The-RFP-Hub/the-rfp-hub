"use client";

/**
 * The last hop of the Google sign-in, and the only page in this app whose URL is briefly a secret.
 *
 * THE HANDOFF, END TO END. Google redirects to the API, which is where the OAuth callback lives and
 * where Better-Auth sets its session cookie — host-only to the API's origin, `HttpOnly`, so this
 * dashboard can never read it and would not know what to do with it if it could. The API's handoff
 * route then exchanges that cookie for a **one-time token** and sends the browser here with the
 * token in the URL FRAGMENT. This page trades it for the bearer session the rest of the client uses
 * (`lib/auth-client.ts`), and moves on.
 *
 * WHY A FRAGMENT, AND WHAT A FRAGMENT DOES NOT BUY. A fragment is never sent to a server, so the
 * token stays out of the API's access logs, out of any proxy's, and out of the `Referer` of the next
 * request. That is the whole of its value. It does NOT keep the token out of the browser's history,
 * out of session restore, out of a crash reporter, or away from an extension. So the URL is rewritten
 * before anything can await, the onward navigation replaces rather than pushes, and the token is
 * single-use on the server — three independent reasons a replayed URL is worthless.
 *
 * `history.replaceState` RUNS BEFORE THE FIRST `await`, and the ordering is load-bearing rather than
 * stylistic: an `await` yields to the event loop, and anything that reads `location.href` in that
 * window — a router, an analytics beacon, an extension — reads the token. It is therefore the very
 * first thing after the token is captured, in the same synchronous run.
 */
import { ErrorState } from "@/components/states";
import { ApiError } from "@/lib/api";
import { authClient, describeTransportFailure, refreshSession } from "@/lib/auth-client";
import { useSignInOpener } from "@/lib/auth-root";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Where a completed sign-in lands. The publisher's own surface, which is why they signed in. */
const DESTINATION = "/dashboard";

export default function AuthCompletePage() {
  const router = useRouter();
  const openSignIn = useSignInOpener();
  const [failure, setFailure] = useState<ApiError | null>(null);
  /**
   * THIS EFFECT'S BODY RUNS AT MOST ONCE PER MOUNT, whatever React or the router does.
   *
   * React Strict Mode — on in this app's `next.config.ts`, and therefore on in development — runs an
   * effect setup, then its cleanup, then the setup AGAIN. Without a guard the first pass scrubbed
   * the fragment and started redeeming, the cleanup marked that request abandoned, and the second
   * pass found an empty fragment and reported `no_handoff_token` — while the first request may well
   * have consumed the one-time token on the server. The visible symptom was that Google sign-in
   * could never complete locally, and it would have looked like an API bug.
   *
   * The guard is set BEFORE the effect branches, not just before the redemption, and that is the
   * stronger property rather than a tidier one. "There was nothing to redeem" has to be decided once
   * too: `setFailure` stores a fresh object, so a re-render that re-entered this effect would set
   * state again and re-render again, forever. That is not hypothetical — it hangs the moment
   * `useRouter()` returns a new object per render, which is precisely what a caller is entitled to
   * do and what the test for this file does. Correctness here should not rest on a dependency's
   * referential stability.
   *
   * A ref rather than state: it must survive a re-render without causing one, and it must be set
   * synchronously in the first pass so the second pass observes it.
   */
  const started = useRef(false);

  useEffect(() => {
    // Already handled by an earlier pass of this same mount — Strict Mode's second setup lands
    // here, and must not touch the fragment, the token, or the failure state again.
    if (started.current) return;
    started.current = true;

    // ── synchronous section: capture, then scrub. No `await` may appear between these two. ──
    const fragment = window.location.hash.replace(/^#/, "");
    const token = new URLSearchParams(fragment).get("ott");
    window.history.replaceState(null, "", window.location.pathname);
    // ── end of the synchronous section ──

    if (!token) {
      setFailure(
        new ApiError(
          0,
          "no_handoff_token",
          "This page finishes a Google sign-in and there is no sign-in in progress. Start again from the sign-in panel.",
        ),
      );
      return;
    }

    void (async () => {
      let outcome: Awaited<ReturnType<typeof authClient.oneTimeToken.verify>>;
      try {
        outcome = await authClient.oneTimeToken.verify({ token });
      } catch (cause) {
        // A REJECTION, NOT AN `error` MEMBER. The client resolves with one for anything the API
        // answered and rejects when the call never landed. Without this the promise was discarded by
        // `void`, no state ever changed, and the page sat on "Completing your sign-in…" forever —
        // with the fragment already scrubbed, so a reload could only report a missing token. The
        // dead end was total.
        setFailure(
          new ApiError(
            0,
            "handoff_unreachable",
            `${describeTransportFailure(cause)} If it keeps failing, start again from the sign-in panel — this link may already have been used.`,
          ),
        );
        return;
      }
      const { error } = outcome;
      if (error) {
        setFailure(
          new ApiError(
            error.status ?? 0,
            error.code ?? "handoff_failed",
            // A used or expired token is the common case and reads as alarming otherwise: the token
            // is valid for three minutes and exactly one redemption, so a reload lands here.
            error.message ??
              "That sign-in link has already been used or has expired. Start again from the sign-in panel.",
          ),
        );
        return;
      }
      // BEFORE navigating, not after. The bearer token is in storage by now (the client's global
      // `onSuccess` hook put it there), but `/one-time-token/verify` is on none of Better-Auth's
      // atom-listener matchers, so `useSession` is still holding the null session it read on first
      // paint. A client-side `replace` keeps the provider mounted and would carry that stale answer
      // straight to `/dashboard`, which would then ask a signed-in user to sign in.
      refreshSession();
      // `replace`, not `push`: the entry this page occupies is the one that held the token, and it
      // must not be somewhere the back button returns to.
      router.replace(DESTINATION);
    })();
    // No cleanup that abandons the request. A one-time token is spent the moment the server sees
    // it, so a "cancelled" redemption is not cancelled in any sense that matters — it is a spent
    // token whose result was thrown away, which is exactly the state that stranded the sign-in.
  }, [router]);

  if (failure) {
    return (
      <section>
        <h1>Sign-in did not complete</h1>
        <ErrorState error={failure} what="your sign-in" />
        {/*
          A WAY OUT, on every failure branch. This page is a dead end by construction — it is reached
          by a redirect, its token is single-use, and its fragment has already been scrubbed — so a
          reader who lands here in error has nothing to click and no URL to go back to. The panel
          opens in place, so they do not lose this tab.
        */}
        <p className="row">
          <button type="button" onClick={openSignIn}>
            Sign in again
          </button>
          <Link href="/">Back to the directory</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Signing you in</h1>
      <output className="state">Completing your sign-in…</output>
    </section>
  );
}
