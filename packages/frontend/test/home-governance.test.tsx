/**
 * Asserted against `<main>` rather than the document: the global footer carries a Governance link on
 * every route, so finding the URL somewhere on the home page proves nothing about the home page.
 */
import DirectoryPage from "@/app/page";
import { Chrome } from "@/components/Chrome";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { GOVERNANCE, REVIEW_CRITERIA } from "@/lib/links";
import type { Me } from "@/lib/types";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({
  session: {
    data: null as { user: { id: string } } | null,
    isPending: false,
    error: null as { status?: number; message?: string } | null,
  },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => session,
    signOut: vi.fn(async () => {}),
    getSession: vi.fn(async () => ({ data: null, error: null })),
  },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

// The directory has its own suite (`public-browse.test.tsx`); this file is about what surrounds it.
vi.mock("@/components/DirectoryList", () => ({
  DirectoryList: () => <p>The directory</p>,
}));

const me: Me = {
  accountId: 7,
  handle: "acme-programs",
  displayName: "Acme Programs",
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

const client = {
  baseUrl: "https://api.example.com",
  me: {
    get: async () => me,
    notifications: async () => ({
      items: [],
      page: 1,
      limit: 1,
      total: 0,
      totalPages: 1,
      unreadCount: 0,
    }),
  },
} as unknown as ApiClient;

function renderHome() {
  return render(
    <ApiClientProvider value={client}>
      <Chrome>
        <DirectoryPage />
      </Chrome>
    </ApiClientProvider>,
  );
}

describe("the home page's governance links", () => {
  beforeEach(() => {
    session.data = null;
    session.isPending = false;
    session.error = null;
  });

  it("links the governance framework from inside main, not only from the footer", async () => {
    const { container } = renderHome();
    await screen.findByText("The directory");

    const main = screen.getByRole("main");
    const footer = container.querySelector("footer");
    expect(footer).toBeTruthy();

    const governance = within(main).getByRole("link", { name: "Governance" });
    expect(governance.getAttribute("href")).toBe(GOVERNANCE);
    expect(footer?.contains(governance)).toBe(false);

    const criteria = within(main).getByRole("link", { name: "Review criteria" });
    expect(criteria.getAttribute("href")).toBe(REVIEW_CRITERIA);
    expect(footer?.contains(criteria)).toBe(false);
  });

  it("keeps them when sign-in itself is unavailable", async () => {
    session.error = { message: "network" };
    renderHome();
    await screen.findByText("The directory");

    await waitFor(() =>
      expect(screen.getByText("This deployment cannot reach its service.")).toBeTruthy(),
    );
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "Governance" }).getAttribute("href")).toBe(
      GOVERNANCE,
    );
  });
});
