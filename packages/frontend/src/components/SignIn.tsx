"use client";

/**
 * Sign-in, which this package now OWNS rather than embeds.
 *
 * Two steps, one screen: an address, then the six-digit code sent to it. There is no password to
 * forget and none to leak, and holding the mailbox is the whole proof — which is also why the same
 * flow both creates an account and signs an existing one back in. Nothing here decides anything: the
 * API mints the code, counts the attempts and issues the session.
 *
 * WHY A SEPARATE `sent` STEP RATHER THAN ONE FORM. The address is needed twice — once to send the
 * code and again to redeem it — and a single form invites a reader to change the address between
 * those two uses, which fails with an error that blames the code. Freezing it, and offering an
 * explicit way back, is what makes "that code is not right" mean what it says.
 *
 * EVERY FAILURE IS THE API'S OWN. The three OTP failures have three different next steps (retype
 * it, ask for a new one, wait), so they are told apart by the plugin's published error codes rather
 * than collapsed into "sign-in failed".
 */
import { ActionNote } from "@/components/states";
import { authClient, describeOtpFailure, describeTransportFailure } from "@/lib/auth-client";
import { HOW_IT_WORKS } from "@/lib/links";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

/** Six digits, as the API mints them (`otpLength: 6`). Used to size and validate the input. */
const OTP_LENGTH = 6;

type Step = "address" | "code";

export function SignIn({
  apiBaseUrl,
  onSignedIn,
}: {
  /** The API's origin. The Google handoff returns THERE, not here — see `handoffUrl` below. */
  apiBaseUrl: string;
  /** Called once a session exists, so the host can close the panel. */
  onSignedIn?: () => void;
}) {
  const [step, setStep] = useState<Step>("address");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  /**
   * Whether this deployment offers Google at all — ASKED, not guessed.
   *
   * `GET /v1/health` now reports `auth.google`, which is a configuration read of the same predicate
   * the auth instance uses to decide whether to register the provider. So the button is offered only
   * when the deployment actually has it, rather than rendered hopefully and withdrawn after somebody
   * presses it — which is what attempt-based detection looks like to the person using it.
   *
   * THE ATTEMPT-BASED WITHDRAWAL IS KEPT AS A FALLBACK, and it is not dead code: an older API answers
   * `/v1/health` without an `auth` member, and a database outage makes that route 503 so the answer
   * cannot be read at all. In both cases "the API did not say" is treated as "offer it and find out",
   * which is strictly better than hiding a working method because a health check was unavailable. A
   * 404 `PROVIDER_NOT_FOUND` from the sign-in call then withdraws it, exactly as before.
   */
  const api = useApi();
  const loadHealth = useCallback(() => api.health(), [api]);
  const health = useResource(loadHealth);
  const advertised = health.state.status === "ready" ? health.state.data.auth?.google : undefined;
  const [googleWithdrawn, setGoogleWithdrawn] = useState(false);
  /* Hidden when the API said no; otherwise shown until an attempt proves otherwise. */
  const showGoogle = advertised !== false && !googleWithdrawn;

  const codeInput = useRef<HTMLInputElement>(null);
  // Move to the code box as soon as it exists: the reader's next action is in their mail client and
  // then here, and making them find the field again is a step nobody needs.
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  /*
   * EVERY HANDLER BELOW CLEARS `busy` IN A `finally`, and that is not defensive habit.
   *
   * The auth client resolves with an `error` member for anything the API answered — a 400, a 404, a
   * rate limit — but REJECTS when the call never landed: connection dropped, DNS gone, CORS refused.
   * Clearing `busy` on the resolved path alone left the panel stuck reading "Sending…" or
   * "Signing in…" forever the moment the API was unreachable, with its buttons disabled and no way
   * to retry short of a reload. The failure that most needs a retry was the one that forbade it.
   */
  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      if (error) {
        setNote({
          kind: "error",
          message: error.message ?? "The code could not be sent. Try again in a moment.",
        });
        return;
      }
      setStep("code");
      setNote({
        kind: "ok",
        message: `Code sent to ${email.trim()}.`,
      });
    } catch (cause) {
      setNote({ kind: "error", message: describeTransportFailure(cause) });
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
      if (error) {
        setNote({
          kind: "error",
          message: describeOtpFailure(
            error.code,
            error.message ?? "That code could not be verified.",
          ),
        });
        // The code stays on screen rather than being cleared: a mistyped digit is the common case
        // and wiping the field makes the reader retype all six.
        return;
      }
      onSignedIn?.();
    } catch (cause) {
      // The code is NOT spent by a request that never arrived, so it stays on screen and stays
      // usable — the reader only has to press the button again.
      setNote({ kind: "error", message: describeTransportFailure(cause) });
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setCode("");
    setStep("address");
    setNote(null);
  };

  /**
   * Where Google returns to.
   *
   * NOT this page directly. The OAuth callback lands on the API, which holds the session cookie for
   * its own origin; its handoff route exchanges that cookie for a one-time token and bounces the
   * browser to `/auth/complete` on a frontend origin, which trades the token for the bearer session
   * this client actually uses. The frontend never sees the cookie.
   *
   * `returnTo` NAMES THE ORIGIN WE STARTED FROM, and omitting it was a bug rather than a
   * simplification: the API falls back to `trustedOrigins[0]`, so a sign-in begun on a preview
   * deployment — or on any trusted origin that is not the first one configured — completed on a
   * DIFFERENT deployment, leaving the tab the user was actually looking at still signed out.
   *
   * This is not a hole in the open-redirect defence. The API parses the value, requires it to be an
   * origin it already trusts for sign-in, and reduces it to that origin — the caller chooses neither
   * the host nor the path, only which of the already-trusted origins to come back to.
   */
  const handoffUrl = `${apiBaseUrl.replace(/\/+$/, "")}/api/auth-handoff?returnTo=${encodeURIComponent(
    window.location.origin,
  )}`;

  const continueWithGoogle = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: handoffUrl,
        // THE ONE EXCEPTION to the package-wide `credentials: "omit"` (see lib/auth-client.ts).
        // This response sets the OAuth state cookie, and under `omit` the browser discards it —
        // the callback then fails `state_mismatch` for everyone, always. The cookie is a
        // five-minute anti-CSRF nonce on the API's own origin (backed by a ten-minute database
        // verification record), not a session: including credentials here attaches no ambient
        // authority anywhere else.
        fetchOptions: { credentials: "include" },
      });
      // Reached only if the redirect did NOT happen — i.e. the call failed.
      if (error?.status === 404) {
        setGoogleWithdrawn(true);
        setNote({
          kind: "error",
          message:
            "This deployment does not offer Google sign-in. Use the code sent to your email.",
        });
        return;
      }
      if (error) {
        setNote({
          kind: "error",
          message: error.message ?? "Google sign-in could not be started.",
        });
      }
    } catch (cause) {
      // A rejection is NOT evidence the provider is absent — the call never reached the API to find
      // out — so the button stays, unlike on a 404.
      setNote({ kind: "error", message: describeTransportFailure(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <h2 id="signin-heading">Log in</h2>
      <p className="muted footnote">
        We email you a {OTP_LENGTH}-digit code. There is no password. The first time you sign in,
        this creates your account; publishing without review additionally requires membership of a
        verified organisation, which a reviewer grants.{" "}
        <Link href={HOW_IT_WORKS}>Who can do what</Link> sets out the whole of it — including
        everything you can already do here without an account.
      </p>

      {step === "address" ? (
        <form onSubmit={sendCode}>
          <div className="field">
            <label htmlFor="signin-email">Email address</label>
            <input
              id="signin-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.org"
            />
          </div>
          <button type="submit" className="button-primary" disabled={busy || email.trim() === ""}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <div className="field">
            <label htmlFor="signin-code">Your {OTP_LENGTH}-digit code</label>
            <p className="hint">
              Sent to <strong>{email.trim()}</strong>. It expires five minutes after it was sent.
            </p>
            <input
              id="signin-code"
              ref={codeInput}
              // `text` with a numeric mode rather than `number`: a code is a string of digits, and
              // `number` brings spinners, silent scroll-wheel edits and a locale-dependent value.
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern={`\\d{${OTP_LENGTH}}`}
              maxLength={OTP_LENGTH}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="row">
            <button
              type="submit"
              className="button-primary"
              disabled={busy || code.trim().length !== OTP_LENGTH}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button type="button" onClick={() => void resend()} disabled={busy}>
              Use a different address
            </button>
          </div>
        </form>
      )}

      <ActionNote note={note} />

      {showGoogle ? (
        <>
          <p className="muted signin-or">or</p>
          <button type="button" onClick={() => void continueWithGoogle()} disabled={busy}>
            Continue with Google
          </button>
        </>
      ) : null}

      <p className="muted footnote">
        This browser stores a session so you can manage your account. Permissions are checked when
        you submit or manage a listing. Signing out removes the session.
      </p>
    </div>
  );
}
