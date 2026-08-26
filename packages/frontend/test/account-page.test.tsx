import AccountPage from "@/app/account/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me } from "@/lib/types";
import { render, screen } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({ usePathname: () => "/account" }));

const account: Me = {
  accountId: 1,
  handle: "publisher",
  displayName: "Publisher",
  email: "publisher@example.org",
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

function mount(me: Me) {
  const client = {
    baseUrl: "https://api.example.com",
    me: { get: async () => me, update: vi.fn() },
  } as unknown as ApiClient;
  return render(
    <ApiClientProvider value={client}>
      <AccountPage />
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  session.data = { user: { id: "u1" } };
});

describe("account organization links", () => {
  it("makes Save the account page's primary action", async () => {
    mount(account);

    expect((await screen.findByRole("button", { name: "Save" })).className).toContain(
      "button-primary",
    );
  });

  it("links the organization index beside the heading and from the empty state", async () => {
    mount(account);

    const links = await screen.findAllByRole("link", { name: "Browse organizations" });
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.getAttribute("href") === "/organizations")).toBe(true);
  });

  it("explains how an account without Direct-create can still publish without review", async () => {
    mount(account);

    const label = await screen.findByRole("rowheader", { name: "Direct-create" });
    expect(label.nextElementSibling?.textContent).toBe(
      "No — this account publishes without review only through a verified organization membership; other submissions wait for review.",
    );
  });

  it("keeps membership names direct while exposing the organization index", async () => {
    mount({
      ...account,
      memberships: [
        { slug: "acme collective", name: "Acme Foundation", role: "publisher", verified: true },
      ],
    });

    expect(
      (await screen.findByRole("link", { name: "Acme Foundation" })).getAttribute("href"),
    ).toBe("/organizations/acme%20collective");
    expect(screen.getByRole("link", { name: "Browse organizations" }).getAttribute("href")).toBe(
      "/organizations",
    );
  });
});
