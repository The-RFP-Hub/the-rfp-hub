import EditListingPage from "@/app/listings/[id]/edit/page";
import ListingPage from "@/app/listings/[id]/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { ManagedOpportunity, Me, Opportunity } from "@/lib/types";
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

function client(): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: async () => me,
      opportunity: async () => entry,
      opportunities: async () => ({
        items: [managed],
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
  } as unknown as ApiClient;
}

const mount = (node: React.ReactNode) =>
  render(<ApiClientProvider value={client()}>{node}</ApiClientProvider>);

beforeEach(() => {
  session.data = { user: { id: "u1" } };
});

describe("merged listing detail and edit routes", () => {
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
});
