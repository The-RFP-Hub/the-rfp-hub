import ListingsPage from "@/app/listings/page";
import type { ApiClient } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { ManagedOpportunity, ManagedOpportunityList, Me } from "@/lib/types";
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/listings",
}));

const me: Me = {
  accountId: 1,
  handle: "publisher",
  displayName: null,
  email: null,
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

const merged: ManagedOpportunity = {
  id: "acme:old round",
  title: "Old Round",
  fundingType: "grant",
  status: "archived",
  reviewStatus: "rejected",
  isListed: false,
  namespace: "acme",
  submittedBy: "publisher",
  mergedInto: { id: "acme:new round", title: "Current Round" },
  lastDecision: { action: "reject", reason: null, at: "2026-08-20T00:00:00Z" },
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
};

const page = (items: ManagedOpportunity[]): ManagedOpportunityList => ({
  items,
  page: 1,
  limit: 20,
  total: items.length,
  totalPages: 1,
});

function client(items: ManagedOpportunity[] = [merged]): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: async () => me,
      opportunities: async (query?: { reviewStatus?: string }) =>
        query?.reviewStatus === "pending" ? page([]) : page(items),
      duplicates: async () => ({ items: [] }),
    },
    opportunities: {
      verification: async () => {
        throw new ApiError(404, "not_found", "not checked");
      },
    },
  } as unknown as ApiClient;
}

beforeEach(() => {
  session.data = { user: { id: "u1" } };
});

describe("the merged row on Your listings", () => {
  it("explains that the duplicate queue identifies both sides", async () => {
    const api = client();
    api.me.duplicates = async () => ({
      items: [
        {
          id: "acme:other",
          title: "Other Round",
          isPublic: true,
          similarity: 0.9,
          status: "suspected",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "My Round" },
        },
      ],
    });

    render(
      <ApiClientProvider value={api}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByText(/See which of your listings was matched/i)).toBeTruthy();
    expect(screen.queryByText(/not which of yours/i)).toBeNull();
  });

  it("links to the survivor and replaces rejection actions with one terminal badge", async () => {
    render(
      <ApiClientProvider value={client()}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    const survivor = await screen.findByRole("link", { name: "Current Round" });
    expect(survivor.getAttribute("href")).toBe("/opportunities/acme%3Anew%20round");
    expect(screen.getByText("Merged", { selector: ".badge" }).className).toContain("badge-merged");
    expect(screen.queryByText("Rejected", { selector: ".badge" })).toBeNull();
    expect(
      screen.queryByText("Hidden from the public directory", { selector: ".badge" }),
    ).toBeNull();
    expect(screen.getByText(/This archived record now points to that listing/)).toBeTruthy();
    expect(screen.queryByText(/No reason was recorded/)).toBeNull();
    expect(screen.queryByText(/Editing it and saving resubmits/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Fix and resubmit" })).toBeNull();
  });

  it("shows a hidden survivor's id as plain text without a public link", async () => {
    const hiddenSurvivor = {
      ...merged,
      mergedInto: { id: "acme:new round", title: null },
    } satisfies ManagedOpportunity;
    render(
      <ApiClientProvider value={client([hiddenSurvivor])}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByText("acme:new round")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "acme:new round" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Current Round" })).toBeNull();
  });
});
