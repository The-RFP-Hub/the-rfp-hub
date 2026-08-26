/**
 * ACCOUNTS AND ROLES — two grants that are easy to confuse and expensive to get wrong.
 *
 * A ROLE CHANGE USED TO FIRE FROM A `<select>`'s change event. That is the worst possible control
 * for this: a stray scroll wheel over a focused dropdown made somebody a reviewer, and nothing on
 * screen said what a reviewer may do. Both halves are fixed here and both are tested — the change is
 * staged behind a confirmation, and the confirmation says what the role grants.
 *
 * SELF-DEMOTION IS THE ONE-WAY DOOR. Only an administrator may change roles, so an administrator who
 * demotes themselves cannot undo it, and if they are the only one nobody can. That warning is
 * asserted for its words.
 *
 * ORGANISATIONS ARE NOT ON THIS PAGE any more; verification is a reviewer capability. A read-only
 * copy of the directory here taught that it was an administrator's job.
 */
import AdminPage from "@/app/admin/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { AccountSummary, Me } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({
  session: { data: { user: { id: "u1" } }, isPending: false, error: null },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut: vi.fn(), getSession: vi.fn() },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));

const me: Me = {
  accountId: 1,
  handle: "root",
  displayName: null,
  email: null,
  role: "admin",
  directCreate: false,
  credentialKind: "session",
  scopes: [],
  memberships: [],
  canManageKeys: true,
  canReview: true,
  canAdmin: true,
  createdAt: "2026-01-01T00:00:00Z",
};

const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 2,
  handle: "indie2",
  displayName: null,
  email: "indie2@example.org",
  globalRole: "submitter",
  directCreate: false,
  createdAt: "2026-02-01T00:00:00Z",
  ...over,
});

const setRole = vi.fn(async () => account());
const setDirectCreate = vi.fn(async () => account());

function client(accounts: AccountSummary[]): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: { get: async () => me },
    review: { accounts: async () => ({ items: accounts }) },
    admin: { setRole, setDirectCreate },
  } as unknown as ApiClient;
}

const mount = (accounts: AccountSummary[] = [account()]) =>
  render(
    <ApiClientProvider value={client(accounts)}>
      <AdminPage />
    </ApiClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());

describe("the page's scope", () => {
  it("does not carry an organisation directory — that lives with the reviewer who verifies them", async () => {
    mount();

    expect(await screen.findByRole("heading", { name: "Accounts & roles" })).toBeTruthy();
    expect(await screen.findByRole("columnheader", { name: "Direct-create" })).toBeTruthy();
    expect(screen.getByLabelText("Search accounts").closest("form")?.className).toBe("search-row");
    expect(screen.queryByRole("columnheader", { name: "Members" })).toBeNull();
    // It says where verification went, rather than leaving a reviewer to guess.
    expect(screen.getByRole("link", { name: /Review queues/ })).toBeTruthy();
  });

  it("clears an applied account search from beside the Search button", async () => {
    const api = client([account()]);
    const accounts = vi.fn(async () => ({ items: [account()] }));
    api.review.accounts = accounts;
    render(
      <ApiClientProvider value={api}>
        <AdminPage />
      </ApiClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText("Search accounts"), {
      target: { value: "indie" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(accounts).toHaveBeenCalledWith({ q: "indie", limit: 25 }));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.getByLabelText("Search accounts")).toHaveProperty("value", "");
    await waitFor(() => expect(accounts).toHaveBeenCalledWith({ q: undefined, limit: 25 }));
  });

  it("searches every supported identifier and uses email as the no-handle identity", async () => {
    mount([
      account(),
      account({ id: 61, handle: null, displayName: null, email: "new.person@example.org" }),
    ]);

    const search = await screen.findByLabelText("Search accounts");
    expect(search).toHaveProperty("placeholder", "handle, name, email or id");
    expect(await screen.findByText("indie2@example.org")).toBeTruthy();
    const emailPrimary = await screen.findByText("new.person@example.org");
    expect(emailPrimary.closest(".row-title")).toBeTruthy();
    expect(screen.queryByText("account 61")).toBeNull();
  });
});

describe("changing a role", () => {
  it("stages the change instead of firing on the select's change event", async () => {
    mount();

    fireEvent.change(await screen.findByLabelText("Global role for account 2"), {
      target: { value: "reviewer" },
    });

    expect(setRole).not.toHaveBeenCalled();
    expect(screen.getByText("Make indie2 a Hub reviewer?")).toBeTruthy();
  });

  it("says what the role grants, at the moment it is granted", async () => {
    mount();

    fireEvent.change(await screen.findByLabelText("Global role for account 2"), {
      target: { value: "reviewer" },
    });

    const panel = screen.getByRole("group", { name: "Make indie2 a Hub reviewer?" });
    expect(within(panel).getByText(/verify organisations/)).toBeTruthy();
    expect(within(panel).getByText(/grants publishing rights over a whole namespace/)).toBeTruthy();
  });

  it("applies the change only on confirmation", async () => {
    mount();

    fireEvent.change(await screen.findByLabelText("Global role for account 2"), {
      target: { value: "admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change the role to Hub admin" }));

    await waitFor(() => expect(setRole).toHaveBeenCalledWith(2, "admin"));
  });

  it("warns an administrator demoting themselves that it cannot be undone here", async () => {
    mount([account({ id: 1, handle: "root", globalRole: "admin" })]);

    fireEvent.change(await screen.findByLabelText("Global role for account 1"), {
      target: { value: "reviewer" },
    });

    const panel = screen.getByRole("group", { name: "Make root a Hub reviewer?" });
    expect(within(panel).getByText(/This is your own account/)).toBeTruthy();
    expect(within(panel).getByText(/If you are the only Hub admin, nobody can\./)).toBeTruthy();
  });

  it("does not warn about self-demotion when somebody else is demoted", async () => {
    mount([account({ id: 2, handle: "indie2", globalRole: "admin" })]);

    fireEvent.change(await screen.findByLabelText("Global role for account 2"), {
      target: { value: "submitter" },
    });

    expect(screen.queryByText(/This is your own account/)).toBeNull();
  });
});

describe("direct create", () => {
  it("names it as the widest grant on the page, and points at the narrower one", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Grant…" }));

    const panel = screen.getByRole("group", { name: "Grant direct-create to indie2?" });
    expect(within(panel).getByText(/any namespace/)).toBeTruthy();
    expect(
      within(panel).getByText(/A membership on a verified organisation is the narrower way/),
    ).toBeTruthy();
    // The thing people assume wrongly: that it makes their API key powerful too.
    expect(within(panel).getByText(/does not elevate an API key/)).toBeTruthy();
    expect(within(panel).getByText("write", { selector: "code" })).toBeTruthy();
    expect(panel.textContent).not.toContain("`write`");
    expect(setDirectCreate).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Grant it" }));
    await waitFor(() => expect(setDirectCreate).toHaveBeenCalledWith(2, true));
  });

  it("says revoking leaves already-published listings alone", async () => {
    mount([account({ directCreate: true })]);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke…" }));

    expect(screen.getByText(/already published stay published/)).toBeTruthy();
  });
});
