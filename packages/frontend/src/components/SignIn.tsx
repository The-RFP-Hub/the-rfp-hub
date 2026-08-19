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
import { type FormEvent, useEffect, useRef, useState } from "react";

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
   * Whether the API turned out to have no Google provider registered.
   *
   * ATTEMPT-BASED DETECTION, and the reasoning is worth stating because the alternative looks
   * cheaper than it is. Nothing the API serves advertises which social providers are configured:
   * the Better-Auth routes are hidden from the OpenAPI document, `/api/auth/ok` reports liveness
   * only, and `GET /v1/health` reports the database. The only side-effect-free probe available is
   * the sign-in call itself, which answers `404 PROVIDER_NOT_FOUND` from its first statement —
   * before any state row is written — when the provider is absent. So the button is offered, and
   * removes itself the once if the deployment does not have Google.
   *
   * The honest cost is one dead click on an email-only deployment. The alternative — probing on
   * mount — cannot be done without side effects, because the SUCCESS path of that same call writes
   * an OAuth state row; and a build-time flag would add back the second environment variable this
   * migration exists to remove. A one-field advertisement on a public endpoint would beat both, and
   * is the follow-up worth taking.
   */
  const [googleAbsent, setGoogleAbsent] = useState(false);

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
        message: `Code sent to ${email.trim()}. It is good for five minutes.`,
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
      });
      // Reached only if the redirect did NOT happen — i.e. the call failed.
      if (error?.status === 404) {
        setGoogleAbsent(true);
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
      <h2 id="signin-heading">Sign in</h2>
      <p className="muted footnote">
        We email you a {OTP_LENGTH}-digit code. There is no password. The first time you sign in,
        this creates your account; publishing without review additionally requires membership of a
        verified organisation, which a reviewer grants.
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
          <button type="submit" disabled={busy || email.trim() === ""}>
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
            <button type="submit" disabled={busy || code.trim().length !== OTP_LENGTH}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button type="button" onClick={() => void resend()} disabled={busy}>
              Use a different address
            </button>
          </div>
        </form>
      )}

      <ActionNote note={note} />

      {googleAbsent ? null : (
        <>
          <p className="muted signin-or">or</p>
          <button type="button" onClick={() => void continueWithGoogle()} disabled={busy}>
            Continue with Google
          </button>
        </>
      )}

      <p className="muted footnote">
        Signing in stores a session token in this browser and sends it to the API, which is the only
        thing that decides what an account may do. Signing out removes it.
      </p>
    </div>
  );
}
