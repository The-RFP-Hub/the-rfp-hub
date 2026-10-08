import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * CLAIMING FROM THE PUBLIC PAGE, including the session boundary around the extracted form.
 *
 * The form itself still speaks the API's outcome message verbatim. The public wrapper adds only
 * the states that a page anybody can read needs: restoring a session, opening sign-in, loading the
 * authenticated account and explaining why an account with no organization cannot file a claim.
 */
import { ClaimForm, PublicClaimControl } from "@/components/ClaimForm";
import { type ApiClient, ApiError, createApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { AuthRoot } from "@/lib/auth-root";
import type { ClaimResult, Me, MeMembership } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSession } = vi.hoisted(() => ({
  authSession: {
    data: null as { user: { id: string } } | null,
    isPending: false,
    error: null as { status?: number; message?: string } | null,
  },
}));

vi.mock("@/lib/auth-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-client")>("@/lib/auth-client");
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      useSession: () => authSession,
      signOut: vi.fn(),
      getSession: vi.fn(),
    },
    clearSessionToken: vi.fn(),
    refreshSession: vi.fn(),
    readSessionToken: () => null,
  };
});

const memberships: MeMembership[] = [
  { slug: "acme", name: "Acme Foundation", role: "publisher", verified: true },
  { slug: "beta", name: "Beta Collective", role: "publisher", verified: false },
];

const account = (memberOf: MeMembership[] = memberships): Me => ({
  accountId: 7,
  handle: "program-operator",
  displayName: "Program Operator",
  email: "operator@acme.example.org",
  role: "submitter",
  directCreate: false,
  credentialKind: "session",
  scopes: [],
  memberships: memberOf,
  canManageKeys: true,
  canReview: false,
  canAdmin: false,
  createdAt: "2026-08-01T00:00:00Z",
});

const result = (
  outcome: ClaimResult["outcome"],
  message: string,
  claimId: number | null = 19,
): ClaimResult => ({
  outcome,
  message,
  claimId,
  opportunityId: "acme:round-4",
  organizationSlug: "acme",
});

function clientFor(options?: {
  me?: Me;
  access?: { canEdit: boolean; canViewManagement: boolean; canClaim?: boolean };
  canClaim?: boolean;
  claim?: (
    id: string,
    body: { organizationSlug: string; note?: string | null },
  ) => Promise<ClaimResult>;
}): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: vi.fn(async () => options?.me ?? account()),
      opportunityAccess: vi.fn(async () => ({
        canClaim: true,
        canAssignSubmission: false,
        ...(options?.access ?? {
          canEdit: false,
          canViewManagement: false,
          canAssumeSubmission: false,
        }),
      })),
    },
    opportunities: {
      claimStatus: vi.fn(async () => ({ canClaim: options?.canClaim ?? true })),
      claim:
        options?.claim ??
        vi.fn(async () => result("granted", "Future writes will publish under acme.")),
    },
  } as unknown as ApiClient;
}

async function renderForm(client: ApiClient, me = account()) {
  render(
    <ApiClientProvider value={client}>
      <ClaimForm id="acme:round-4" me={me} />
    </ApiClientProvider>,
  );
  fireEvent.click(await screen.findByText("This is my program — claim it"));
}

beforeEach(() => {
  vi.clearAllMocks();
  authSession.data = null;
  authSession.isPending = false;
  authSession.error = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public claim control", () => {
  it.each([
    { canEdit: true, canViewManagement: true, canAssumeSubmission: false },
    { canEdit: false, canViewManagement: true, canAssumeSubmission: false },
  ])("replaces claim with the actions authorized by the server: %j", async (access) => {
    authSession.data = { user: { id: "user_7" } };
    const client = clientFor({ access });
    render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );
    const details = await screen.findByRole("link", { name: "View management details" });
    expect(details.getAttribute("href")).toBe("/listings/acme%3Around-4");
    expect(Boolean(screen.queryByRole("link", { name: "Edit program" }))).toBe(access.canEdit);
    expect(screen.queryByText("This is my program — claim it")).toBeNull();
    expect(screen.queryByRole("button", { name: "File the claim" })).toBeNull();
    expect(client.opportunities.claim).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "hides claim for a globally owned program, signed in: %s",
    async (signedIn) => {
      if (signedIn) authSession.data = { user: { id: "user_7" } };
      const client = clientFor({
        canClaim: false,
        access: { canEdit: false, canViewManagement: false, canClaim: false },
      });
      const { container } = render(
        <ApiClientProvider value={client}>
          <PublicClaimControl id="acme:round-4" />
        </ApiClientProvider>,
      );
      await waitFor(() => expect(container.textContent).toBe(""));
      expect(screen.queryByText("This is my program — claim it")).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in to claim" })).toBeNull();
      expect(client.opportunities.claim).not.toHaveBeenCalled();
    },
  );

  it("hides the extracted form when ownership has already been established", async () => {
    const client = clientFor({
      access: { canEdit: false, canViewManagement: false, canClaim: false },
    });
    const { container } = render(
      <ApiClientProvider value={client}>
        <ClaimForm id="acme:round-4" me={account()} />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(client.opportunities.claim).not.toHaveBeenCalled();
  });

  it("refreshes ownership and removes claim when a stale page is refused", async () => {
    authSession.data = { user: { id: "user_7" } };
    const claim = vi.fn(async (): Promise<ClaimResult> => {
      throw new ApiError(409, "already_claimed", "This program already has an owner.");
    });
    const client = clientFor({ claim });
    vi.mocked(client.me.opportunityAccess)
      .mockResolvedValueOnce({
        canEdit: false,
        canViewManagement: false,
        canAssumeSubmission: false,
        canAssignSubmission: false,
        canClaim: true,
      })
      .mockResolvedValue({
        canEdit: false,
        canViewManagement: false,
        canAssumeSubmission: false,
        canAssignSubmission: false,
        canClaim: false,
      });
    const { container } = render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "File the claim" }));
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("does not offer claim when checking access fails, and lets the user retry", async () => {
    authSession.data = { user: { id: "user_7" } };
    const client = clientFor();
    vi.mocked(client.me.opportunityAccess).mockRejectedValueOnce(
      new ApiError(503, "unavailable", "Access check unavailable."),
    );
    render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Check access again" }));
    expect(screen.queryByRole("button", { name: "File the claim" })).toBeNull();
    expect(await screen.findByRole("button", { name: "File the claim" })).toBeTruthy();
  });

  it("opens the existing sign-in overlay from the signed-out CTA without requesting /v1/me", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ status: "ok", db: "up", auth: { google: false }, canClaim: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    render(
      <AuthRoot apiBaseUrl="https://api.example.com">
        <PublicClaimControl id="acme:round-4" />
      </AuthRoot>,
    );

    fireEvent.click(await screen.findByText("This is my program — claim it"));
    fireEvent.click(screen.getByRole("button", { name: "Sign in to claim" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Log in" })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("/v1/me"))).toBe(true);
  });

  it("lets a signed-in account with no membership file a claim for a named organization", async () => {
    authSession.data = { user: { id: "user_7" } };
    const claim = vi.fn(async () =>
      result("queued", "you are not a member, so a reviewer will decide."),
    );
    const client = clientFor({ me: account([]), claim });

    render(
      <ApiClientProvider value={client}>
        <PublicClaimControl
          id="acme:round-4"
          organizations={[{ slug: "prezenti", name: "Prezenti" }]}
        />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByText("This is my program — claim it"));
    expect(client.me.get).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Approval adds you as a publisher/)).toBeTruthy();
    expect((screen.getByLabelText("Organization") as HTMLSelectElement).value).toBe("prezenti");

    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "\u0000other" } });
    fireEvent.change(screen.getByLabelText("Organization slug"), {
      target: { value: " Optimism " },
    });
    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));

    await waitFor(() =>
      expect(claim).toHaveBeenCalledWith("acme:round-4", {
        organizationSlug: "optimism",
        note: null,
      }),
    );
  });

  it("keeps the same disclosure open while sign-in loads the claim form", async () => {
    const client = clientFor();
    const view = render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    const summary = await screen.findByText("This is my program — claim it");
    const disclosure = summary.closest("details") as HTMLDetailsElement;
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);

    authSession.data = { user: { id: "user_7" } };
    view.rerender(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "File the claim" })).toBeTruthy();
    expect(
      (screen.getByText("This is my program — claim it").closest("details") as HTMLDetailsElement)
        .open,
    ).toBe(true);
  });

  it("closes and resets the public claim draft on Cancel", async () => {
    authSession.data = { user: { id: "user_7" } };
    const client = clientFor();
    render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    await screen.findByRole("button", { name: "File the claim" });
    const summary = await screen.findByText("This is my program — claim it");
    fireEvent.click(summary);
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "beta" } });
    fireEvent.change(screen.getByLabelText("Note for the reviewer (optional)"), {
      target: { value: "Unsent public note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(summary);
    expect((screen.getByLabelText("Organization") as HTMLSelectElement).value).toBe("acme");
    expect(
      (screen.getByLabelText("Note for the reviewer (optional)") as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows the first queued HTTP 202 outcome even when the session refreshes in flight", async () => {
    authSession.data = { user: { id: "user_7" } };
    let answerClaim: ((response: Response) => void) | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/access")) {
        return new Response(
          JSON.stringify({ canViewManagement: false, canEdit: false, canClaim: true }),
        );
      }
      if (String(input).endsWith("/v1/me")) {
        return new Response(JSON.stringify(account()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          answerClaim = resolve;
        });
      }
      throw new Error(`Unexpected request: ${init?.method} ${String(input)}`);
    });
    const client = createApiClient({ baseUrl: "https://api.example.com", fetchImpl: fetch });
    const view = render(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByText("This is my program — claim it"));
    fireEvent.click(await screen.findByRole("button", { name: "File the claim" }));

    const filing = await screen.findByRole("button", { name: "Filing…" });
    expect(filing).toHaveProperty("disabled", true);
    await waitFor(() => expect(answerClaim).toBeTypeOf("function"));

    authSession.isPending = true;
    view.rerender(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    await act(async () => {
      answerClaim?.(
        new Response(JSON.stringify(result("queued", "A reviewer will decide this claim.")), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    authSession.isPending = false;
    view.rerender(
      <ApiClientProvider value={client}>
        <PublicClaimControl id="acme:round-4" />
      </ApiClientProvider>,
    );

    expect(await screen.findByText("A reviewer will decide this claim.")).toBeTruthy();
  });
  it("does not carry a queued outcome into another account", async () => {
    const client = clientFor({
      claim: vi.fn(async () => result("queued", "First account request.")),
    });
    const view = render(
      <ApiClientProvider value={client}>
        <ClaimForm id="acme:round-4" me={account()} />
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByText("This is my program — claim it"));
    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));
    await screen.findByText("First account request.");
    view.rerender(
      <ApiClientProvider value={client}>
        <ClaimForm id="acme:round-4" me={{ ...account(), accountId: 8 }} />
      </ApiClientProvider>,
    );
    await screen.findByText("This is my program — claim it");
    expect(screen.queryByText("First account request.")).toBeNull();
    expect(
      screen.queryByText("Your request is awaiting review. You do not need to submit it again."),
    ).toBeNull();
  });
});

describe("the extracted claim form", () => {
  it("replaces a granted claim with editing and management actions", async () => {
    await renderForm(clientFor());
    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));
    expect(await screen.findByRole("link", { name: "Edit program" })).toBeTruthy();
    expect(screen.queryByText("This is my program — claim it")).toBeNull();
    expect(screen.queryByRole("button", { name: "File the claim" })).toBeNull();
  });

  it("shows every membership and selects the first one by default", async () => {
    await renderForm(clientFor());

    const select = screen.getByLabelText("Organization") as HTMLSelectElement;
    expect(select.value).toBe("acme");
    expect(screen.getByRole("option", { name: "Acme Foundation — acme (verified)" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Beta Collective — beta (unverified)" }),
    ).toBeTruthy();
  });

  it("closes on Cancel and discards the unsent organization and note", async () => {
    await renderForm(clientFor());

    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "beta" } });
    fireEvent.change(screen.getByLabelText("Note for the reviewer (optional)"), {
      target: { value: "Unsent note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const summary = await screen.findByText("This is my program — claim it");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(summary);
    expect((screen.getByLabelText("Organization") as HTMLSelectElement).value).toBe("acme");
    expect(
      (screen.getByLabelText("Note for the reviewer (optional)") as HTMLInputElement).value,
    ).toBe("");
  });

  it("posts exactly the selected organization and reviewer note", async () => {
    const claim = vi.fn(async () => result("queued", "A reviewer will decide this claim."));
    await renderForm(clientFor({ claim }));

    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "beta" } });
    fireEvent.change(screen.getByLabelText("Note for the reviewer (optional)"), {
      target: { value: "I operate this program for Beta." },
    });
    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));

    await waitFor(() =>
      expect(claim).toHaveBeenCalledWith("acme:round-4", {
        organizationSlug: "beta",
        note: "I operate this program for Beta.",
      }),
    );
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it.each([
    result("queued", "A reviewer will decide this claim."),
    result("unchanged", "Acme already publishes this opportunity.", null),
  ])("renders the API's $outcome outcome message verbatim", async (answer) => {
    const claim = vi.fn(async () => answer);
    await renderForm(clientFor({ claim }));

    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));

    expect(await screen.findByText(answer.message)).toBeTruthy();
  });

  it("surfaces a conflict with a different verified publisher legibly", async () => {
    const claim = vi.fn(async (): Promise<ClaimResult> => {
      throw new ApiError(
        409,
        "verified_publisher_conflict",
        "This opportunity already has a different verified publisher.",
      );
    });
    await renderForm(clientFor({ claim }));

    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));

    const message = await screen.findByText(
      "This opportunity already has a different verified publisher.",
      { selector: "output" },
    );
    expect(message.tagName).toBe("OUTPUT");
    expect(message.className).toContain("error");
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("verified_publisher_conflict")).toBeTruthy();
  });

  it("shows the API's error feedback and allows another attempt", async () => {
    const claim = vi.fn(async (): Promise<ClaimResult> => {
      throw new ApiError(503, "unavailable", "Claims are temporarily unavailable.");
    });
    await renderForm(clientFor({ claim }));

    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));

    expect(
      await screen.findByText("Claims are temporarily unavailable.", { selector: "output" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "File the claim" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("keeps the private listing page free of claim UI and claim calls", () => {
    const source = readFileSync(join(process.cwd(), "src/app/listings/[id]/page.tsx"), "utf8");

    expect(source).not.toContain("ClaimForm");
    expect(source).not.toContain("opportunities.claim");
    expect(source).not.toContain("This is my program — claim it");
  });
});
