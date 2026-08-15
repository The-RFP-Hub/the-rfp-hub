/**
 * The four states a page can be in before it knows who is looking, proven rather than eyeballed.
 *
 * A real end-to-end check needs an interactive login against a real auth application, which cannot
 * run unattended — that gap is covered by the manual checklist in the README. What CAN be proven
 * here is the branching, and it is the branching that goes wrong: showing a login prompt to
 * somebody whose session is still being restored, or a spinner to somebody for whom sign-in is
 * broken, are both failures a screenshot review misses because each looks momentarily plausible.
 *
 * The auth SDK is mocked at the module boundary. Nothing else is: `RequireSession` runs its real
 * logic and calls the real `GET /v1/me` through an injected client.
 */
import { RequireSession } from "@/components/Chrome";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me } from "@/lib/types";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const privy = {
  ready: true,
  authenticated: false,
  error: null as Error | null,
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  getAccessToken: vi.fn(async () => "token"),
};

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => privy,
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/listings" }));

const me: Me = {
  accountId: 7,
  handle: "acme-programs",
  displayName: "Acme Programs",
  email: null,
  primaryWallet: null,
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
) {
  return render(
    <ApiClientProvider value={client}>
      <RequireSession capability={capability}>
        {(account) => <p>Hello {account.handle}</p>}
      </RequireSession>
    </ApiClientProvider>,
  );
}

const clientFor = (loader: () => Promise<Me>): ApiClient =>
  ({ baseUrl: "https://api.example.com", me: { get: loader } }) as unknown as ApiClient;

describe("RequireSession", () => {
  beforeEach(() => {
    privy.ready = true;
    privy.authenticated = false;
    privy.error = null;
  });

  it("waits rather than claiming you are logged out while the session is being restored", () => {
    privy.ready = false;
    renderGate(clientFor(async () => me));

    expect(screen.getByText(/Loading your session/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("offers a login, and says what the page is for, when nobody is signed in", () => {
    renderGate(clientFor(async () => me));

    expect(screen.getByText("You are not signed in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
  });

  it("says sign-in is unavailable — not 'logged out' — when the SDK could not start", () => {
    privy.error = new Error("Invalid app ID");
    renderGate(clientFor(async () => me));

    expect(screen.getByText("Sign-in is unavailable.")).toBeTruthy();
    expect(screen.getByText(/Invalid app ID/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("renders the page once the API has answered who this is", async () => {
    privy.authenticated = true;
    renderGate(clientFor(async () => me));

    await waitFor(() => expect(screen.getByText(/Hello acme-programs/)).toBeTruthy());
  });

  it("reports a missing capability from the API's own answer, and never a queue", async () => {
    privy.authenticated = true;
    renderGate(
      clientFor(async () => me),
      {
        needs: (account) => account.canReview,
        label: "the reviewer capability",
      },
    );

    await waitFor(() =>
      expect(screen.getByText(/does not have the reviewer capability/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Hello acme-programs/)).toBeNull();
  });
});
