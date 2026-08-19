/**
 * THE SIGN-IN UI, WHICH THIS PACKAGE NOW OWNS.
 *
 * It used to be a third party's modal, so there was nothing here to test and nothing here that could
 * break. Now the two-step flow, the three OTP failures and the Google button are all ours, and each
 * one is a thing a user hits on their first ever interaction with this product — the least
 * forgiving place for a regression.
 *
 * The auth client is mocked at the module boundary, exactly as `session-states.test.tsx` mocks it.
 * Nothing else is: the component's real state machine runs, and the assertions are about what a
 * person sees and what the API is asked for.
 */
import { SignIn } from "@/components/SignIn";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { error: { code?: string; message?: string; status?: number } | null };

const { sendVerificationOtp, signInEmailOtp, signInSocial } = vi.hoisted(() => ({
  sendVerificationOtp: vi.fn(async (): Promise<Answer> => ({ error: null })),
  signInEmailOtp: vi.fn(async (): Promise<Answer> => ({ error: null })),
  // Typed parameter, so a test can read `mock.calls[0][0].callbackURL` rather than cast it blind.
  signInSocial: vi.fn(
    async (_options: { provider: string; callbackURL: string }): Promise<Answer> => ({
      error: null,
    }),
  ),
}));

vi.mock("@/lib/auth-client", async () => {
  // The failure-code → sentence mapping is real logic, not a stub: it is what decides whether a
  // reader retypes a digit or asks for a new code, so the test exercises the shipped function.
  const actual = await vi.importActual<typeof import("@/lib/auth-client")>("@/lib/auth-client");
  return {
    describeOtpFailure: actual.describeOtpFailure,
    // Real, like the failure mapper above: the sentence a reader gets when the call never landed is
    // the thing under test, not a stub of it.
    describeTransportFailure: actual.describeTransportFailure,
    authClient: {
      emailOtp: { sendVerificationOtp },
      signIn: { emailOtp: signInEmailOtp, social: signInSocial },
    },
  };
});

const API = "https://api.example.com";

/**
 * The panel now asks `/v1/health` which sign-in methods this deployment has, so it needs a client.
 * `health` is overridable per test: the three interesting answers are "google: true", "google:
 * false" and "the API did not say".
 */
const client = (
  health: () => Promise<unknown> = async () => ({
    status: "ok",
    db: "up",
    auth: { google: true },
  }),
): ApiClient => ({ baseUrl: API, health }) as unknown as ApiClient;

const mount = (onSignedIn?: () => void, health?: () => Promise<unknown>) =>
  render(
    <ApiClientProvider value={client(health)}>
      <SignIn apiBaseUrl={API} onSignedIn={onSignedIn} />
    </ApiClientProvider>,
  );

/** Fill the address and ask for a code — the shared first half of every case below. */
async function reachCodeStep(email = "programs@acme.example.org") {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  return screen.findByLabelText(/6-digit code/);
}

describe("signing in with an email code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendVerificationOtp.mockResolvedValue({ error: null });
    signInEmailOtp.mockResolvedValue({ error: null });
    signInSocial.mockResolvedValue({ error: null });
  });

  it("asks for an address first, and will not send an empty one", () => {
    mount();

    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send code" })).toHaveProperty("disabled", true);
    // The code box does not exist yet — there is nothing to type into until a code was sent.
    expect(screen.queryByLabelText(/6-digit code/)).toBeNull();
  });

  it("sends the code, then asks for it — naming the address it went to", async () => {
    mount();
    await reachCodeStep();

    expect(sendVerificationOtp).toHaveBeenCalledWith({
      email: "programs@acme.example.org",
      type: "sign-in",
    });
    expect(screen.getByText(/Code sent to programs@acme\.example\.org/)).toBeTruthy();
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  it("submits the code and reports the session upward", async () => {
    const onSignedIn = vi.fn();
    mount(onSignedIn);
    const code = await reachCodeStep();

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(signInEmailOtp).toHaveBeenCalledWith({
      email: "programs@acme.example.org",
      otp: "123456",
    });
  });

  it("keeps the submit button disabled until six digits are present", async () => {
    mount();
    const code = await reachCodeStep();

    expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", true);
    fireEvent.change(code, { target: { value: "12345" } });
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", true);
    fireEvent.change(code, { target: { value: "123456" } });
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", false);
  });

  it("keeps non-digits out of the code box rather than failing on the server", async () => {
    mount();
    const code = await reachCodeStep();

    fireEvent.change(code, { target: { value: "12-34 56ab" } });
    expect((code as HTMLInputElement).value).toBe("123456");
  });

  it("tells a wrong code apart from an expired one and from a locked-out one", async () => {
    const cases = [
      ["INVALID_OTP", /That code is not right/],
      ["OTP_EXPIRED", /That code has expired/],
      ["TOO_MANY_ATTEMPTS", /Too many attempts/],
    ] as const;

    for (const [code, expected] of cases) {
      signInEmailOtp.mockResolvedValueOnce({
        error: { code, message: "Invalid OTP", status: 400 },
      });
      const view = mount();
      const input = await reachCodeStep();
      fireEvent.change(input, { target: { value: "000000" } });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
      // The digits stay on screen: a mistyped one is the common case, and clearing the field makes
      // the reader retype all six.
      expect((input as HTMLInputElement).value).toBe("000000");
      view.unmount();
    }
  });

  it("reports a failure to SEND without pretending a code is on its way", async () => {
    sendVerificationOtp.mockResolvedValueOnce({
      error: { status: 500, message: "The mail transport is not configured." },
    });
    mount();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "programs@acme.example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await waitFor(() =>
      expect(screen.getByText("The mail transport is not configured.")).toBeTruthy(),
    );
    // Still on the address step — offering a code box for a code nobody was sent is the lie here.
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("offers a way back to the address, because that is what a typo needs", async () => {
    mount();
    await reachCodeStep("wrong@acme.example.org");

    fireEvent.click(screen.getByRole("button", { name: "Use a different address" }));

    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeTruthy());
  });
});

describe("the Google button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendVerificationOtp.mockResolvedValue({ error: null });
    signInSocial.mockResolvedValue({ error: null });
  });

  it("hands off to the API's own handoff route, naming the origin we started from", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() =>
      expect(signInSocial).toHaveBeenCalledWith({
        provider: "google",
        // The OAuth cookie belongs to the API's origin; the frontend never sees it.
        //
        // `returnTo` is the part that was missing and it was a real bug: without it the API falls
        // back to `trustedOrigins[0]`, so a sign-in begun on a preview deployment finished on a
        // different one, leaving the tab the user was looking at still signed out. It is not a hole
        // in the open-redirect defence — the API still requires the value to be an origin it already
        // trusts, and reduces it to that origin.
        callbackURL: `${API}/api/auth-handoff?returnTo=${encodeURIComponent(
          window.location.origin,
        )}`,
      }),
    );
  });

  it("percent-encodes the origin so it cannot smuggle extra query parameters", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(signInSocial).toHaveBeenCalled());
    const callbackURL = signInSocial.mock.calls[0]?.[0].callbackURL ?? "";
    const parsed = new URL(callbackURL);
    // Exactly one parameter, and it round-trips to the origin rather than to anything appended
    // after an unencoded `&` or `#`.
    expect([...parsed.searchParams.keys()]).toEqual(["returnTo"]);
    expect(parsed.searchParams.get("returnTo")).toBe(window.location.origin);
    expect(parsed.pathname).toBe("/api/auth-handoff");
  });

  it("removes itself when the deployment turns out to have no Google provider", async () => {
    // ATTEMPT-BASED DETECTION. Nothing the API serves advertises which social providers are
    // configured, and the only side-effect-free probe is this call itself: Better-Auth answers
    // `404 PROVIDER_NOT_FOUND` from the first statement of the handler, before any state row is
    // written. So the button is offered once and then withdraws.
    signInSocial.mockResolvedValueOnce({
      error: { status: 404, code: "PROVIDER_NOT_FOUND", message: "Provider not found" },
    });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(screen.getByText(/does not offer Google sign-in/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    // Email still works — the panel degrades to one method rather than to none.
    expect(screen.getByRole("button", { name: "Send code" })).toBeTruthy();
  });

  it("keeps the button for any other failure, which is not evidence the provider is absent", async () => {
    signInSocial.mockResolvedValueOnce({
      error: { status: 500, message: "Google is having a moment." },
    });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(screen.getByText("Google is having a moment.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });
});

/**
 * WHEN THE CALL NEVER LANDS AT ALL.
 *
 * The auth client resolves with an `error` member for anything the API answered, and REJECTS when
 * the request did not arrive — a dropped connection, DNS, a CORS refusal. Handlers that cleared
 * `busy` only on the resolved path therefore froze the panel on "Sending…" or "Signing in…", with
 * every button disabled, exactly when the user most needed to press one again. A reload was the only
 * way out, and nothing on screen said so.
 */
describe("when the sign-in service cannot be reached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendVerificationOtp.mockResolvedValue({ error: null });
    signInEmailOtp.mockResolvedValue({ error: null });
    signInSocial.mockResolvedValue({ error: null });
  });

  it("recovers the Send-code button instead of freezing on 'Sending…'", async () => {
    sendVerificationOtp.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "programs@acme.example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await waitFor(() => expect(screen.getByText(/could not be reached/)).toBeTruthy());
    // Back to a pressable button, on the step it started on — the request never happened, so there
    // is no code to ask for.
    const button = screen.getByRole("button", { name: "Send code" });
    expect(button).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("recovers the Sign-in button, and keeps the code, when verification cannot be sent", async () => {
    mount();
    const code = await reachCodeStep();
    signInEmailOtp.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText(/could not be reached/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", false);
    // A code is not spent by a request that never arrived, so it stays usable.
    expect((code as HTMLInputElement).value).toBe("123456");
  });

  it("keeps the Google button, because a rejection is not evidence the provider is absent", async () => {
    signInSocial.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(screen.getByText(/could not be reached/)).toBeTruthy());
    // Unlike the 404, which DOES tell us the deployment has no Google provider.
    const google = screen.getByRole("button", { name: "Continue with Google" });
    expect(google).toHaveProperty("disabled", false);
  });
});

/**
 * WHICH SIGN-IN METHODS THIS DEPLOYMENT ACTUALLY HAS.
 *
 * The panel used to render the Google button hopefully and withdraw it after somebody pressed it
 * and got a 404 — which, to the person using it, is a button that does not work. `/v1/health` now
 * reports `auth.google`, so the button is offered only when the deployment has it.
 *
 * The fallback is not dead code: an older API omits `auth`, and a database outage makes the route
 * 503 so nothing can be read off it. "The API did not say" has to mean "offer it and find out",
 * because hiding a working method because a health check was unavailable is the worse failure.
 */
describe("advertised sign-in methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendVerificationOtp.mockResolvedValue({ error: null });
    signInSocial.mockResolvedValue({ error: null });
  });

  it("offers Google when the API says the deployment has it", async () => {
    mount(undefined, async () => ({ status: "ok", db: "up", auth: { google: true } }));

    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });

  it("hides Google when the API says it does not, without anybody having to press it", async () => {
    mount(undefined, async () => ({ status: "ok", db: "up", auth: { google: false } }));

    // Email is present, so the panel has rendered and this is a real absence rather than a race.
    expect(await screen.findByRole("button", { name: "Send code" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull(),
    );
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("falls back to trying when an older API omits the field", async () => {
    mount(undefined, async () => ({ status: "ok", db: "up" }));

    const google = await screen.findByRole("button", { name: "Continue with Google" });
    // And the attempt-based withdrawal still works from there.
    signInSocial.mockResolvedValueOnce({
      error: { status: 404, code: "PROVIDER_NOT_FOUND", message: "Provider not found" },
    });
    fireEvent.click(google);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull(),
    );
  });

  it("falls back to trying when health itself cannot be read", async () => {
    mount(undefined, async () => {
      throw new ApiError(503, "degraded", "the database is down");
    });

    // A health check that failed is not evidence about Google.
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });
});
