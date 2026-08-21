/**
 * THE LAST HOP OF THE GOOGLE SIGN-IN, which had two failures that no other test could see.
 *
 * Both were state-management bugs rather than logic bugs, which is exactly the kind that survives
 * review: the code reads correctly line by line, and it is the interaction with React's lifecycle
 * and with Better-Auth's session atom that is wrong.
 *
 *   1. STRICT MODE. `reactStrictMode: true` is on, so in development React runs an effect's setup,
 *      its cleanup, and its setup again. The first pass scrubbed the fragment and began redeeming
 *      the one-time token; the second found an empty fragment and reported "no sign-in in progress"
 *      — while the first request had very likely already spent the token on the server. Google
 *      sign-in could therefore never complete locally, and it looked like an API fault.
 *   2. THE SESSION ATOM. `/one-time-token/verify` matches none of Better-Auth's atom listeners, so
 *      a successful exchange left `useSession` holding the null session it read on first paint. A
 *      client-side navigation keeps the provider mounted, so `/dashboard` asked a user who had just
 *      signed in to sign in again, until a full reload.
 *
 * The fragment-hygiene properties are asserted here too, since this is the one page in the app whose
 * URL is briefly a credential.
 */
import AuthCompletePage from "@/app/auth/complete/page";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verify, refreshSession, replace, openSignIn } = vi.hoisted(() => ({
  verify: vi.fn(async () => ({
    error: null as { status?: number; code?: string; message?: string } | null,
  })),
  refreshSession: vi.fn(),
  replace: vi.fn(),
  openSignIn: vi.fn(),
}));

vi.mock("@/lib/auth-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-client")>("@/lib/auth-client");
  return {
    authClient: { oneTimeToken: { verify } },
    refreshSession,
    // Real: the sentence shown when the exchange never reached the API is the thing under test.
    describeTransportFailure: actual.describeTransportFailure,
  };
});

vi.mock("@/lib/auth-root", () => ({ useSignInOpener: () => openSignIn }));

/**
 * `useRouter` returns a NEW object on every call, deliberately.
 *
 * A caller is entitled to do that, and the page's run-once property must not quietly depend on the
 * router being referentially stable. It did: the no-token branch stored a fresh error object, which
 * re-rendered, which re-entered the effect, which set state again — the suite hung until the guard
 * moved above the branch. Keeping the mock unstable is what stops that regressing.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

/** Put a handoff token in the fragment, exactly as the API's redirect does. */
function arriveWithToken(token = "ott-abc123") {
  window.history.replaceState(null, "", `/auth/complete#ott=${token}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ error: null });
  window.history.replaceState(null, "", "/auth/complete");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("completing the handoff", () => {
  it("redeems the token exactly ONCE under Strict Mode, and does not report a missing one", async () => {
    arriveWithToken();

    render(
      <StrictMode>
        <AuthCompletePage />
      </StrictMode>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    // The whole point: a second redemption would spend a token that is valid for exactly one.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ token: "ott-abc123" });
    // And the second effect pass must not have reported the fragment it deliberately scrubbed.
    expect(screen.queryByText(/no sign-in in progress/)).toBeNull();
  });

  it("refreshes the session BEFORE navigating, or the destination sees a stale null session", async () => {
    arriveWithToken();

    render(<AuthCompletePage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    // Ordering is the property under test: navigating first would hand `/dashboard` the session
    // answer read on first paint, which is `null`.
    expect(refreshSession.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0] as number,
    );
  });

  it("scrubs the token out of the URL before anything can await", async () => {
    arriveWithToken();

    render(<AuthCompletePage />);

    // Synchronously after the effect, and certainly by the time the exchange resolves.
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(window.location.href).not.toContain("ott-abc123");
  });

  it("says there is no sign-in in progress when the page is opened with no token", async () => {
    render(<AuthCompletePage />);

    expect(await screen.findByText(/no sign-in in progress/)).toBeTruthy();
    expect(verify).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("reports a spent or expired token as the API's own answer, and does not navigate", async () => {
    arriveWithToken();
    verify.mockResolvedValue({
      error: { status: 401, code: "invalid_token", message: "That link has already been used." },
    });

    render(<AuthCompletePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("That link has already been used.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

/**
 * WHEN THE EXCHANGE NEVER REACHES THE API.
 *
 * The worst dead end in the app, and the easiest to miss: the redemption runs in a detached async
 * IIFE, the client REJECTS rather than resolving with an `error` for a transport failure, and `void`
 * discarded that rejection. No state changed, so the page sat on "Completing your sign-in…"
 * indefinitely — and because the fragment had already been scrubbed, a reload could only report a
 * missing token. There was no way forward and no way back.
 */
describe("when the handoff cannot reach the API", () => {
  beforeEach(() => {
    arriveWithToken();
  });

  it("stops waiting and says what happened, instead of spinning forever", async () => {
    verify.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<AuthCompletePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
    // Honest about the token: it is single-use, and we cannot know whether the server saw it.
    expect(screen.getByText(/may already have been used/)).toBeTruthy();
    expect(screen.queryByText(/Completing your sign-in/)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("offers a way out of a page that is otherwise a dead end", async () => {
    verify.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<AuthCompletePage />);

    const again = await screen.findByRole("button", { name: "Sign in again" });
    fireEvent.click(again);
    expect(openSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Back to the directory" }).getAttribute("href")).toBe(
      "/",
    );
  });

  it("offers the same way out when the token was simply spent", async () => {
    verify.mockResolvedValue({
      error: { status: 401, code: "invalid_token", message: "That link has already been used." },
    });

    render(<AuthCompletePage />);

    expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
});
