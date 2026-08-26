import ListingsPage from "@/app/listings/page";
import type { ApiClient } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { PublisherStatus } from "@/lib/presentation";
import type { ManagedOpportunity, ManagedOpportunityList, Me } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      opportunities: async (query?: { publisherStatus?: PublisherStatus }) =>
        query?.publisherStatus === "pending" ? page([]) : page(items),
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
  it("keeps the duplicate submit action in the empty state secondary", async () => {
    render(
      <ApiClientProvider value={client([])}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Submit an opportunity" })).toHaveLength(2),
    );
    const links = screen.getAllByRole("link", { name: "Submit an opportunity" });
    expect(links).toHaveLength(2);
    expect(links.filter((link) => link.className.includes("button-primary"))).toHaveLength(1);
  });

  it("renders exactly one derived badge for every reachable publisher state", async () => {
    const row = (
      status: PublisherStatus,
      over: Partial<ManagedOpportunity>,
    ): ManagedOpportunity => ({
      ...merged,
      id: `acme:${status}`,
      title: status,
      mergedInto: null,
      lastDecision: null,
      ...over,
    });
    const items = [
      { ...merged, isListed: true },
      row("rejected", { reviewStatus: "rejected", isListed: true }),
      row("pending", { reviewStatus: "pending", isListed: true }),
      row("hidden", { reviewStatus: "approved", isListed: false }),
      row("live", { reviewStatus: "approved", isListed: true }),
    ];

    render(
      <ApiClientProvider value={client(items)}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    for (const [status, label] of [
      ["merged", "Merged"],
      ["rejected", "Rejected"],
      ["pending", "Waiting for review"],
      ["hidden", "Hidden from directory"],
      ["live", "Live"],
    ] as const) {
      expect(await screen.findByText(label, { selector: `.badge-${status}` })).toBeTruthy();
    }
    expect(screen.queryByText("Approved", { selector: ".badge" })).toBeNull();
    expect(
      screen.queryByText("Visible in the public directory", { selector: ".badge" }),
    ).toBeNull();
  });

  it("sends publisherStatus only from the publisher filter", async () => {
    const api = client([]);
    const opportunities = vi.fn(async (_query?: { publisherStatus?: PublisherStatus }) => page([]));
    api.me.opportunities = opportunities;
    render(
      <ApiClientProvider value={api}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hidden from directory" }));
    await waitFor(() =>
      expect(opportunities).toHaveBeenCalledWith({
        publisherStatus: "hidden",
        page: 1,
        limit: 20,
      }),
    );
    expect(opportunities.mock.calls.some(([query]) => query && "reviewStatus" in query)).toBe(
      false,
    );
  });

  it("loads pending count for a verified member and shows the journey when one exists", async () => {
    const api = client([]);
    api.me.get = async () => ({
      ...me,
      memberships: [{ slug: "acme", name: "Acme Foundation", role: "publisher", verified: true }],
    });
    const opportunities = vi.fn(async (query?: { publisherStatus?: PublisherStatus }) =>
      query?.publisherStatus === "pending" ? { ...page([]), total: 1 } : page([]),
    );
    api.me.opportunities = opportunities;

    render(
      <ApiClientProvider value={api}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    const journey = await screen.findByRole("list", { name: "Publishing journey" });
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toBe("In review");
    expect(opportunities).toHaveBeenCalledWith({ publisherStatus: "pending", limit: 1 });
    expect(screen.queryByText(/submission slots in review/)).toBeNull();
  });

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

  it("counts only open duplicate pairs and points resolved-only accounts to their history", async () => {
    const openApi = client();
    openApi.me.duplicates = async () => ({
      items: [
        {
          id: "acme:suspected",
          title: "Suspected",
          isPublic: true,
          similarity: 0.9,
          status: "suspected",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "Mine" },
        },
        {
          id: "acme:confirmed",
          title: "Confirmed",
          isPublic: true,
          similarity: 0.89,
          status: "confirmed",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "Mine" },
        },
        {
          id: "acme:dismissed",
          title: "Dismissed",
          isPublic: true,
          similarity: 0.88,
          status: "dismissed",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "Mine" },
        },
      ],
    });
    const openView = render(
      <ApiClientProvider value={openApi}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByText(/2 possible duplicates touch your listings/)).toBeTruthy();
    openView.unmount();

    openApi.me.duplicates = async () => ({
      items: [
        {
          id: "acme:suspected",
          title: "Suspected",
          isPublic: true,
          similarity: 0.9,
          status: "suspected",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "Mine" },
        },
      ],
    });
    const singularView = render(
      <ApiClientProvider value={openApi}>
        <ListingsPage />
      </ApiClientProvider>,
    );
    expect(await screen.findByText(/1 possible duplicate touches your listings/)).toBeTruthy();
    singularView.unmount();

    const resolvedApi = client();
    resolvedApi.me.duplicates = async () => ({
      items: [
        {
          id: "acme:dismissed",
          title: "Dismissed",
          isPublic: true,
          similarity: 0.88,
          status: "dismissed",
          detectedAt: "2026-08-20T00:00:00Z",
          yourListing: { id: "acme:mine", title: "Mine" },
        },
      ],
    });
    render(
      <ApiClientProvider value={resolvedApi}>
        <ListingsPage />
      </ApiClientProvider>,
    );

    expect(
      await screen.findByText(/No matches need review; resolved history is available/i),
    ).toBeTruthy();
    expect(screen.queryByText(/1 possible duplicate touches/)).toBeNull();
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
