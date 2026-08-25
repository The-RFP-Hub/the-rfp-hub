import EditListingPage from "@/app/listings/[id]/edit/page";
import ListingPage from "@/app/listings/[id]/page";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { ManagedOpportunity, Me, Opportunity } from "@/lib/types";
import { fireEvent, render, screen } from "@testing-library/react";
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
  useParams: () => ({ id: "acme%3Aold" }),
  usePathname: () => "/listings/acme%3Aold",
  useSearchParams: () => new URLSearchParams(),
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

const entry = {
  specVersion: "1.0.0",
  id: "acme:old",
  fundingType: "grant",
  title: "Old Round",
  description: "The archived source record.",
  status: "archived",
  operatingOrganizations: [{ name: "Acme", slug: "acme" }],
  source: { publisher: "acme", submittedBy: "publisher" },
  deadlines: [],
  fundingDetails: { fundingType: "grant" },
} as Opportunity;

const managed: ManagedOpportunity = {
  id: "acme:old",
  title: "Old Round",
  fundingType: "grant",
  status: "archived",
  reviewStatus: "rejected",
  isListed: false,
  namespace: "acme",
  submittedBy: "publisher",
  mergedInto: { id: "acme:current round", title: "Current Round" },
  lastDecision: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
};

function client(managedOpportunity: ManagedOpportunity = managed, currentMe: Me = me): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: async () => currentMe,
      opportunity: async () => entry,
      opportunities: async () => ({
        items: [managedOpportunity],
        page: 1,
        limit: 1,
        total: 1,
        totalPages: 1,
      }),
    },
    insights: {
      forOpportunity: async () => ({
        opportunityId: entry.id,
        title: entry.title,
        from: "2026-08-01",
        to: "2026-08-20",
        totals: { listViews: 0, detailViews: 0, sourceClicks: 0, applyClicks: 0 },
        days: [],
      }),
    },
    opportunities: {
      duplicates: async () => ({
        items: [
          {
            id: "public:current round",
            title: "Public Current Round",
            isPublic: true,
            similarity: 0.92,
            status: "suspected",
            detectedAt: "2026-08-21T00:00:00Z",
          },
          {
            id: "private:queued round",
            title: "Private Queued Round",
            isPublic: false,
            similarity: 0.83,
            status: "confirmed",
            detectedAt: "2026-08-22T00:00:00Z",
          },
          {
            id: "public:dismissed round",
            title: "Dismissed Round",
            isPublic: true,
            similarity: 0.8,
            status: "dismissed",
            detectedAt: "2026-08-23T00:00:00Z",
          },
          {
            id: "public:merged round",
            title: "Merged Round",
            isPublic: true,
            similarity: 0.79,
            status: "merged",
            detectedAt: "2026-08-24T00:00:00Z",
          },
        ],
      }),
    },
  } as unknown as ApiClient;
}

const mount = (node: React.ReactNode, api: ApiClient = client()) =>
  render(<ApiClientProvider value={api}>{node}</ApiClientProvider>);

beforeEach(() => {
  session.data = { user: { id: "u1" } };
});

describe("merged listing detail and edit routes", () => {
  it("shows one publisher state by the title and keeps application stage separate", async () => {
    const hidden = {
      ...managed,
      reviewStatus: "approved",
      isListed: false,
      mergedInto: null,
    } satisfies ManagedOpportunity;
    mount(<ListingPage />, client(hidden));

    expect(
      await screen.findByText("Hidden from directory", { selector: ".badge-hidden" }),
    ).toBeTruthy();
    expect(screen.getByText("Archived", { selector: ".badge-archived" })).toBeTruthy();
    expect(screen.getByText("Application stage")).toBeTruthy();
    expect(screen.getByText("Approved", { selector: ".badge-approved" })).toBeTruthy();
    expect(
      screen.getByText("Hidden from the public directory", { selector: ".badge-unlisted" }),
    ).toBeTruthy();
    expect(screen.getByText("Review decision")).toBeTruthy();
    expect(screen.getByText("Public visibility")).toBeTruthy();
  });

  it("retains the full editorial axes when a Hub reviewer opens the detail", async () => {
    const hidden = {
      ...managed,
      reviewStatus: "approved",
      isListed: false,
      mergedInto: null,
    } satisfies ManagedOpportunity;
    const reviewer = { ...me, role: "reviewer", canReview: true } satisfies Me;
    mount(<ListingPage />, client(hidden, reviewer));

    expect(
      await screen.findByText("Hidden from directory", { selector: ".badge-hidden" }),
    ).toBeTruthy();
    expect(screen.getByText("Approved", { selector: ".badge-approved" })).toBeTruthy();
    expect(
      screen.getByText("Hidden from the public directory", { selector: ".badge-unlisted" }),
    ).toBeTruthy();
    expect(screen.getByText("Review decision")).toBeTruthy();
    expect(screen.getByText("Public visibility")).toBeTruthy();
  });

  it("shows the survivor banner on detail and removes Edit", async () => {
    mount(<ListingPage />);

    const banner = await screen.findByLabelText("Merged listing");
    const survivor = screen.getByRole("link", { name: "Current Round" });
    expect(banner).toBeTruthy();
    expect(survivor.getAttribute("href")).toBe("/opportunities/acme%3Acurrent%20round");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("shows the survivor banner instead of mounting the edit form", async () => {
    mount(<EditListingPage />);

    expect(await screen.findByLabelText("Merged listing")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Current Round" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.queryByText(/A replace re-runs Standard validation/)).toBeNull();
  });

  it("renders a hidden survivor's id without a public link on detail and edit", async () => {
    const hiddenSurvivor = {
      ...managed,
      mergedInto: { id: "acme:current round", title: null },
    } satisfies ManagedOpportunity;

    const detail = mount(<ListingPage />, client(hiddenSurvivor));
    const detailBanner = await screen.findByLabelText("Merged listing");
    expect(detailBanner.textContent).toContain("acme:current round");
    expect(screen.queryByRole("link", { name: "acme:current round" })).toBeNull();
    detail.unmount();

    mount(<EditListingPage />, client(hiddenSurvivor));
    const editBanner = await screen.findByLabelText("Merged listing");
    expect(editBanner.textContent).toContain("acme:current round");
    expect(screen.queryByRole("link", { name: "acme:current round" })).toBeNull();
  });

  it("names the loaded listing in its duplicate rows and routes counterparts by publicity", async () => {
    mount(<ListingPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "Duplicates · 2" }));

    expect(await screen.findByRole("columnheader", { name: "Your listing" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Matched against" })).toBeTruthy();
    for (const ownLink of screen.getAllByRole("link", { name: "Old Round" })) {
      expect(ownLink.getAttribute("href")).toBe("/listings/acme%3Aold");
    }
    expect(screen.getByRole("link", { name: "Public Current Round" }).getAttribute("href")).toBe(
      "/opportunities/public%3Acurrent%20round",
    );
    expect(screen.getByRole("link", { name: "Private Queued Round" }).getAttribute("href")).toBe(
      "/listings/private%3Aqueued%20round",
    );
  });

  it("loads duplicate history once and badges only the open pairs before the tab is opened", async () => {
    const api = client();
    const duplicates = vi.fn(api.opportunities.duplicates);
    api.opportunities.duplicates = duplicates;
    mount(<ListingPage />, api);

    expect(await screen.findByRole("tab", { name: "Duplicates · 2" })).toBeTruthy();
    expect(duplicates).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "Duplicates · 2" }));
    expect(await screen.findByText("Dismissed Round")).toBeTruthy();
    expect(screen.getByText("Merged Round")).toBeTruthy();
    expect(duplicates).toHaveBeenCalledTimes(1);
  });

  it("renders no detail tabs when the full listing fails to load", async () => {
    const failing = client();
    failing.me.opportunity = async () => {
      throw new ApiError(500, "load_failed", "The full listing failed to load.");
    };

    mount(<ListingPage />, failing);

    expect(await screen.findByText(/We couldn’t load this listing/)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
