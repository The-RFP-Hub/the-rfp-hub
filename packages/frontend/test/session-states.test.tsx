/**
 * The four states a page can be in before it knows who is looking, proven rather than eyeballed.
 *
 * A real end-to-end check needs a real mailbox and a real code, which the E2E suite now does with a
 * deterministic transport; that gap used to be a manual checklist item because an interactive login
 * against a third-party provider could not run unattended. What CAN be proven here is the branching,
 * and it is the branching that goes wrong: showing a login prompt to somebody whose session is still
 * being restored, or a spinner to somebody for whom sign-in is broken, are both failures a
 * screenshot review misses because each looks momentarily plausible.
 *
 * THE MOCK BOUNDARY MOVED, AND THAT IS THE POINT OF THIS FILE STILL EXISTING UNCHANGED IN SHAPE.
 * It used to stub a third-party SDK hook; it now stubs our own auth client. All five cases survived
 * the swap verbatim, which is the evidence that `SessionState` really did keep its contract:
 * `RequireSession` runs its real logic and calls the real `GET /v1/me` through an injected client.
 */
import { Chrome, RequireSession, organisationNav } from "@/components/Chrome";
import { NavigationBlockerProvider, useNavigationBlocker } from "@/components/NavigationBlocker";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { opportunityDraftKey } from "@/lib/opportunity-draft";
import { CAPABILITY_DENIAL_COPY, type GateCopy, ROUTE_GATE_COPY } from "@/lib/presentation";
import { useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `authClient.useSession()` reports. The three members map onto the three things a page has to
 * tell apart: still asking (`isPending`), asked and nobody is signed in (`data: null`), and could
 * not ask at all (`error`).
 */
const { session, signOut, getSession, clearSessionToken, refreshSession } = vi.hoisted(() => ({
  session: {
    data: null as { user: { id: string } } | null,
    isPending: false,
    error: null as { status?: number; message?: string } | null,
  },
  signOut: vi.fn(async () => {}),
  getSession: vi.fn(async () => ({ data: null, error: null })),
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
}));

// `vi.hoisted` above, because `vi.mock`'s factory is lifted over the imports and the mocked module
// is loaded before any ordinary top-level `const` has run.
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut, getSession },
  clearSessionToken,
  refreshSession,
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/listings" }));

const me: Me = {
  accountId: 7,
  handle: "acme-programs",
  displayName: "Acme Programs",
  // KEPT. `/v1/me` still serves it — the API joins it from the auth user record — even though the
  // provider that used to supply it is gone. `primaryWallet` is what left, with the wallet login.
  email: "programs@acme.example.org",
  role: "submitter",
  directCreate: false,
  credentialKind: "session",
  scopes: [],
  memberships: [],
  canManageKeys: true,
  canReview: false,
  canAdmin: false,
  createdAt: "2026-08-01T00:00:00Z",
};

function renderGate(
  client: ApiClient,
  capability?: Parameters<typeof RequireSession>[0]["capability"],
  gate?: GateCopy,
) {
  return render(
    <ApiClientProvider value={client}>
      <RequireSession capability={capability} gate={gate}>
        {(account) => <p>Hello {account.handle}</p>}
      </RequireSession>
    </ApiClientProvider>,
  );
}

const clientFor = (loader: () => Promise<Me>): ApiClient =>
  ({ baseUrl: "https://api.example.com", me: { get: loader } }) as unknown as ApiClient;

describe("RequireSession", () => {
  beforeEach(() => {
    session.data = null;
    session.isPending = false;
    session.error = null;
  });

  it("waits rather than claiming you are logged out while the session is being restored", () => {
    session.isPending = true;
    renderGate(clientFor(async () => me));

    expect(screen.getByText(/Loading your session/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("offers a login, and says what the page is for, when nobody is signed in", () => {
    renderGate(clientFor(async () => me));

    expect(screen.getByText("You are not signed in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
  });

  it.each([
    [
      "/listings",
      ROUTE_GATE_COPY.listings,
      "Sign in to manage your listings.",
      "See what is waiting for review, live, rejected, merged, or hidden.",
    ],
    [
      "/listings/new",
      ROUTE_GATE_COPY.newListing,
      "Sign in to submit an opportunity.",
      "After signing in, you can restore any draft saved for this account on this device.",
    ],
    [
      "/listings/[id]",
      ROUTE_GATE_COPY.listing,
      "Sign in to view this listing.",
      "See its review status, history, matches, and publishing controls.",
    ],
    [
      "/listings/[id]/edit",
      ROUTE_GATE_COPY.editListing,
      "Sign in to edit this listing.",
      "Open the saved listing and the account controls available to you.",
    ],
    [
      "/account",
      ROUTE_GATE_COPY.account,
      "Sign in to view your account.",
      "See your Hub role and verified organisation memberships.",
    ],
    [
      "/organisations",
      ROUTE_GATE_COPY.organisations,
      "Sign in to view your organisations.",
      "See the organisations where this account has publishing rights.",
    ],
    [
      "/organisations/[slug]",
      ROUTE_GATE_COPY.organisation,
      "Sign in to view this organisation.",
      "Check your membership and manage the listings in its namespace.",
    ],
    [
      "/duplicates",
      ROUTE_GATE_COPY.duplicates,
      "Sign in to review matches involving your listings.",
      "These matches are private to listing owners and reviewers.",
    ],
    [
      "/keys",
      ROUTE_GATE_COPY.keys,
      "Sign in to manage API keys.",
      "API keys can publish or update listings on your behalf.",
    ],
    [
      "/review",
      ROUTE_GATE_COPY.review,
      "Sign in with a Hub reviewer account.",
      "Review submissions, claims, organisations, and duplicate matches.",
    ],
    [
      "/admin",
      ROUTE_GATE_COPY.admin,
      "Sign in with a Hub administrator account.",
      "Manage Hub roles and direct-publishing access.",
    ],
  ] as const)("renders the route-specific gate for %s", (_route, gate, title, detail) => {
    renderGate(
      clientFor(async () => me),
      undefined,
      gate,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
  });

  it("says sign-in is unavailable — not 'logged out' — when the API could not be asked", () => {
    session.error = { status: 0, message: "Failed to fetch" };
    renderGate(clientFor(async () => me));

    expect(screen.getByText("This deployment cannot reach its service.")).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/Failed to fetch/)).toBeTruthy();
    expect(within(details).getByText("NEXT_PUBLIC_API_URL")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("renders the page once the API has answered who this is", async () => {
    session.data = { user: { id: "user_1" } };
    renderGate(clientFor(async () => me));

    await waitFor(() => expect(screen.getByText(/Hello acme-programs/)).toBeTruthy());
  });

  it.each([
    ["reviewer", CAPABILITY_DENIAL_COPY.reviewer],
    ["administrator", CAPABILITY_DENIAL_COPY.admin],
    ["key management", CAPABILITY_DENIAL_COPY.keyManagement],
  ] as const)("reports a missing %s capability from the API's own answer", async (_name, copy) => {
    session.data = { user: { id: "user_1" } };
    renderGate(
      clientFor(async () => me),
      { needs: () => false, ...copy },
    );

    await waitFor(() => expect(screen.getByText(copy.title)).toBeTruthy());
    expect(screen.getByText(copy.detail)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See who can do what" }).getAttribute("href")).toBe(
      "/how-it-works#roles",
    );
    expect(screen.queryByText(/Hello acme-programs/)).toBeNull();
  });
});

describe("organisation navigation", () => {
  const acme: Me["memberships"][number] = {
    slug: "acme",
    name: "Acme Foundation",
    role: "publisher",
    verified: true,
  };
  const beta: Me["memberships"][number] = {
    slug: "beta collective",
    name: "Beta Collective",
    role: "owner",
    verified: false,
  };

  it.each([
    ["zero memberships", [], "/organisations", "Organisations"],
    ["one membership", [acme], "/organisations/acme", "Acme Foundation"],
    ["multiple memberships", [acme, beta], "/organisations", "Organisations"],
  ] as const)(
    "links %s to the useful organisation destination",
    (_case, memberships, href, label) => {
      expect(organisationNav({ ...me, memberships: [...memberships] })).toEqual({ href, label });
    },
  );
});

/**
 * SIGNING OUT HAS TO TAKE THE UI WITH IT, and the failing path is the one that did not.
 *
 * Better-Auth refreshes `useSession` from an atom listener on `/sign-out`, which fires when the
 * request SUCCEEDS. When it does not — the API is unreachable, or answers 5xx — the token is still
 * cleared locally, and without an explicit invalidation the tab went on rendering signed-in
 * navigation and capability gates while every request it made was anonymous and 401'd. The user's
 * only way out was a reload, and nothing on screen suggested one.
 */
function LogoutHarness() {
  const session = useSession();
  return (
    <button type="button" onClick={() => void session.logout()}>
      Log out
    </button>
  );
}

describe("logout", () => {
  const client = { baseUrl: "https://api.example.com", me: { get: async () => me } };

  beforeEach(() => {
    // The call counts below are absolute ("exactly once"), so they need a clean slate per test —
    // these spies are module-scoped and would otherwise carry the previous case's calls in.
    vi.clearAllMocks();
    session.data = { user: { id: "user_1" } };
    session.isPending = false;
    session.error = null;
    signOut.mockResolvedValue(undefined);
  });

  it("clears the token and invalidates the session on the happy path", async () => {
    localStorage.setItem(opportunityDraftKey(7), "draft one");
    localStorage.setItem(opportunityDraftKey(8), "draft two");
    localStorage.setItem("rfphub.preference", "kept");
    render(
      <ApiClientProvider value={client as unknown as ApiClient}>
        <LogoutHarness />
      </ApiClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(clearSessionToken).toHaveBeenCalledTimes(1));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(opportunityDraftKey(7))).toBeNull();
    expect(localStorage.getItem(opportunityDraftKey(8))).toBeNull();
    expect(localStorage.getItem("rfphub.preference")).toBe("kept");
  });

  it("still clears and invalidates when the sign-out REQUEST fails, and does not reject", async () => {
    signOut.mockRejectedValue(new Error("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ApiClientProvider value={client as unknown as ApiClient}>
        <LogoutHarness />
      </ApiClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    // THE REGRESSION: the token was cleared but the session atom was left holding a signed-in
    // answer, so the chrome stayed signed in over a session that no longer existed.
    await waitFor(() => expect(clearSessionToken).toHaveBeenCalledTimes(1));
    // And it must not reject: every caller fires it as `void session.logout()`, so a rejection is
    // an unhandled one. The failure is reported to the console instead.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("asks the server first, so a revocable session is never orphaned", async () => {
    render(
      <ApiClientProvider value={client as unknown as ApiClient}>
        <LogoutHarness />
      </ApiClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(clearSessionToken).toHaveBeenCalled());
    // Clearing the token first would leave the server-side session alive with nothing left to
    // revoke it with — a sign-out that only looks like one.
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(
      clearSessionToken.mock.invocationCallOrder[0] as number,
    );
  });
});

function DirtyPage() {
  const { setBlocked } = useNavigationBlocker();
  useEffect(() => {
    setBlocked(true);
    return () => setBlocked(false);
  }, [setBlocked]);
  return <p>Dirty form</p>;
}

describe("the header logout guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue(undefined);
  });

  it("does not log out when a dirty form's leave confirmation is declined", async () => {
    session.data = { user: { id: "user_1" } };
    session.isPending = false;
    session.error = null;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <ApiClientProvider value={clientFor(async () => me)}>
        <NavigationBlockerProvider>
          <Chrome>
            <DirtyPage />
          </Chrome>
        </NavigationBlockerProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("Dirty form")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
