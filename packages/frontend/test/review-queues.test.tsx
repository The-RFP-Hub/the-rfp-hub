/**
 * THE REVIEW SURFACE, where every button is a decision somebody else has to live with.
 *
 * Three properties are worth holding here, and none of them is visible in an API test:
 *
 *   1. NOTHING CONSEQUENTIAL FIRES ON THE FIRST CLICK. Approving publishes a stranger's listing to
 *      the world; verifying an organisation hands publishing rights to everyone in it, including
 *      people added later. The confirmations are asserted for their WORDS — "this is not a badge; it
 *      is a grant of publishing power" is the entire reason the panel exists.
 *   2. A REFUSAL CARRIES A REASON. The API allows a reviewer to refuse without one; this UI does
 *      not, because the reason is the only thing that tells a submitter what to fix.
 *   3. THE ORGANISATIONS TAB IS SEARCH-FIRST. The directory auto-registers a stub for every
 *      organisation any listing merely names, so an unfiltered list is hundreds of names nobody
 *      vouched for — and verifying the wrong row from it grants a namespace to whoever is added
 *      next. Stubs must not appear until somebody searches for one.
 */
import ReviewPage from "@/app/review/page";
import type { ApiClient } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me, OrganizationSummary } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, tab, replace } = vi.hoisted(() => ({
  session: { data: { user: { id: "u1" } }, isPending: false, error: null },
  tab: { current: null as string | null },
  replace: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut: vi.fn(), getSession: vi.fn() },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(tab.current ? `tab=${tab.current}` : ""),
  usePathname: () => "/review",
}));

const me: Me = {
  accountId: 1,
  handle: "hub-reviewer",
  displayName: null,
  email: null,
  role: "reviewer",
  directCreate: false,
  credentialKind: "session",
  scopes: [],
  memberships: [],
  canManageKeys: true,
  canReview: true,
  canAdmin: false,
  createdAt: "2026-01-01T00:00:00Z",
};

const pending = {
  id: "indie:grant-1",
  title: "Indie Dev Grants",
  fundingType: "grant",
  status: "open",
  reviewStatus: "pending",
  isListed: false,
  namespace: "indie-collective",
  submittedBy: "indie2",
  lastDecision: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const org = (over: Partial<OrganizationSummary> = {}): OrganizationSummary => ({
  slug: "indie-collective",
  name: "Indie Collective",
  verified: false,
  verifiedAt: null,
  website: null,
  ecosystems: [],
  memberCount: 1,
  ...over,
});

const verifiedOrg = org({
  slug: "filecoin",
  name: "Filecoin Foundation",
  verified: true,
  verifiedAt: "2026-08-14T00:00:00Z",
  memberCount: 2,
});
const stub = org({ slug: "0g", name: "0G", memberCount: 0 });

const approve = vi.fn(async () => ({ id: "x", reviewStatus: "approved", isListed: true }));
const reject = vi.fn(async () => ({ id: "x", reviewStatus: "rejected", isListed: false }));
const reviewOpportunity = vi.fn(async () => ({
  id: "indie:grant-1",
  title: "Indie Dev Grants",
  summary: "A grants round for independent maintainers.",
  applicationUrl: "https://indie.example.org/apply",
}));
const verifyOrganization = vi.fn(async () => verifiedOrg);
const grantMembership = vi.fn(async () => ({
  organizationSlug: "indie-collective",
  accountId: 42,
  role: "publisher",
  member: true,
}));
const accounts = vi.fn(async () => ({
  items: [
    {
      id: 42,
      handle: "fil-ops",
      displayName: null,
      globalRole: "submitter",
      directCreate: false,
      createdAt: "2026-02-01T00:00:00Z",
    },
  ],
}));
const organizations = vi.fn(
  async (query?: { q?: string; verified?: boolean }): Promise<{ items: OrganizationSummary[] }> => {
    if (query?.verified === true) return { items: [verifiedOrg] };
    if (query?.verified === false) return { items: [org()] };
    // A search sees everything, stubs included.
    return { items: [verifiedOrg, org(), stub] };
  },
);

function client(): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: { get: async () => me },
    /*
     * THE PUBLIC READ 404s A PENDING LISTING — which is the whole population of this queue. A panel
     * built on it could never once have shown the thing it exists to show, so the stub refuses it
     * exactly as the API would.
     */
    directory: {
      find: async () => {
        throw new ApiError(404, "not_found", "no such published opportunity");
      },
    },
    review: {
      opportunity: reviewOpportunity,
      opportunities: async () => ({
        items: [pending],
        page: 1,
        limit: 50,
        total: 7,
        totalPages: 1,
      }),
      claims: async () => ({ items: [] }),
      duplicates: async () => ({ items: [] }),
      organizations,
      approve,
      reject,
      verifyOrganization,
      grantMembership,
      accounts,
      unverifyOrganization: vi.fn(),
      verifySource: vi.fn(),
    },
  } as unknown as ApiClient;
}

const mount = () =>
  render(
    <ApiClientProvider value={client()}>
      <ReviewPage />
    </ApiClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  tab.current = null;
});

describe("the tabs", () => {
  it("carries each queue's count, so a reviewer sees the backlog before opening it", async () => {
    mount();

    expect(await screen.findByRole("tab", { name: "Submissions · 7" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Claims · 0" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Duplicates · 0" })).toBeTruthy();
  });

  it("reads the open tab from the URL, so a link to one lands on it", async () => {
    tab.current = "organisations";
    mount();

    expect(await screen.findByRole("tab", { name: "Organisations", selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Submissions/, selected: false })).toBeTruthy();
  });

  it("puts the tab in the address when one is chosen", async () => {
    mount();

    fireEvent.click(await screen.findByRole("tab", { name: "Organisations" }));
    expect(replace).toHaveBeenCalledWith("/review?tab=organisations");
  });
});

describe("deciding a submission", () => {
  it("shows the evidence a decision needs — for a PENDING row, which is all of them", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Details" }));

    // Read through the reviewer route, which is entitled by role. The public one 404s everything in
    // this queue by definition.
    await waitFor(() => expect(reviewOpportunity).toHaveBeenCalledWith("indie:grant-1"));
    expect(await screen.findByText(/A grants round for independent maintainers/)).toBeTruthy();
    expect(screen.getByText("https://indie.example.org/apply")).toBeTruthy();

    // Both the row and the panel name the submitter; the panel is what is under test.
    expect(screen.getAllByText("indie2").length).toBeGreaterThan(1);
    expect(screen.getAllByText("indie-collective").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: /Check the source link/ })).toBeTruthy();
  });

  it("does not publish on the first click", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByText("Publish this listing?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("indie:grant-1"));
  });

  it("requires a reason to refuse, and sends it", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    expect(screen.getByRole("button", { name: "Refuse it" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/shown to whoever submitted it/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "the application link 404s" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse it" }));

    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith("indie:grant-1", "the application link 404s"),
    );
  });
});

describe("the way back", () => {
  it("sends the reviewer's own address with every listing link", async () => {
    mount();

    const link = await screen.findByRole("link", { name: "Indie Dev Grants" });
    const url = new URL(link.getAttribute("href") ?? "", "https://x.example");

    expect(url.pathname).toBe("/listings/indie%3Agrant-1");
    expect(url.searchParams.get("back")).toBe("/review");
    // No label: the path already says what the place is, so no attacker-controlled text is carried.
    expect(url.searchParams.get("backLabel")).toBeNull();
  });

  it("carries the tab as query state, so returning lands on the queue that was open", async () => {
    // The expander's own link is on the submissions tab; the tab string is what varies, and it is
    // the same string the tab switcher writes into the address bar.
    tab.current = "claims";
    mount();

    fireEvent.click(await screen.findByRole("tab", { name: /Submissions/ }));
    expect(replace).toHaveBeenCalledWith("/review");

    fireEvent.click(screen.getByRole("tab", { name: /Duplicates/ }));
    expect(replace).toHaveBeenCalledWith("/review?tab=duplicates");
  });
});

describe("the organisations tab", () => {
  beforeEach(() => {
    tab.current = "organisations";
  });

  it("separates what is verified from what merely has members", async () => {
    mount();

    expect(await screen.findByText(/^Verified/)).toBeTruthy();
    expect(screen.getByText(/Has members, not verified/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Filecoin Foundation")).toBeTruthy());
    expect(screen.getByText("Indie Collective")).toBeTruthy();
  });

  it("hides directory stubs until somebody searches for one", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());
    // The stub is in the corpus and the API would return it — it must not be on screen unasked.
    expect(screen.queryByText("0G")).toBeNull();

    fireEvent.change(screen.getByLabelText(/Search organisations/), { target: { value: "0g" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("0G")).toBeTruthy());
  });

  it("states that verifying is a grant of power, not a badge", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Verify…" }));

    const panel = screen.getByRole("group", { name: "Verify Indie Collective?" });
    expect(
      within(panel).getByText(/This is not a badge; it is a grant of publishing power/),
    ).toBeTruthy();
    expect(within(panel).getByText(/every member added later/)).toBeTruthy();
    expect(within(panel).getByText(/already-published listings stay published/)).toBeTruthy();
    expect(verifyOrganization).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Verify organisation" }));
    await waitFor(() => expect(verifyOrganization).toHaveBeenCalledWith("indie-collective"));
  });

  it("grants a membership, resolving the handle the reviewer knows to the id the API wants", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());

    // By ROW: the Verified section renders first, so "the first Grant button" is Filecoin's.
    const row = screen.getByText("Indie Collective").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Grant a membership…" }));
    fireEvent.change(screen.getByLabelText("Account handle or id"), {
      target: { value: "fil-ops" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));

    // The API takes an integer account id; a reviewer reading a claim knows the handle.
    await waitFor(() => expect(accounts).toHaveBeenCalledWith({ q: "fil-ops", limit: 10 }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose" }));

    expect(grantMembership).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Grant the membership" }));

    await waitFor(() =>
      expect(grantMembership).toHaveBeenCalledWith("indie-collective", {
        accountId: 42,
        role: "publisher",
      }),
    );

    /*
     * AND THE CONFIRMATION IS ACTUALLY SEEN. It used to be composed and thrown away: confirming
     * closed the panel, which unmounted the component holding the note, so the message landed on an
     * unmounted tree. The grant worked and the feedback died — the worst shape for an action whose
     * only visible outcome is a member count going up by one.
     */
    expect(await screen.findByText("fil-ops is now publisher of indie-collective.")).toBeTruthy();
    // The panel is gone; the note is not.
    expect(screen.queryByText("Grant a membership on")).toBeNull();
  });

  it("states the consequence differently for a verified organisation", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Filecoin Foundation")).toBeTruthy());

    const row = screen.getByText("Filecoin Foundation").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Grant a membership…" }));
    fireEvent.change(screen.getByLabelText("Account handle or id"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));

    const panel = await screen.findByRole("group", { name: /Make account 42 a publisher/ });
    // On a verified organisation the membership IS the grant — nothing else has to happen.
    expect(
      within(panel).getByText(/publish into the[\s\S]*immediately and without\s+review/),
    ).toBeTruthy();
  });

  it("refuses to verify a memberless stub, and says what to do instead", async () => {
    mount();

    // The search box only exists once the account read has come back and the tab has rendered.
    fireEvent.change(await screen.findByLabelText(/Search organisations/), {
      target: { value: "0g" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("0G")).toBeTruthy());

    // The stub's own row carries the warning before anything is clicked.
    expect(screen.getByText(/verifying grants nothing today/)).toBeTruthy();

    const rows = screen.getAllByRole("button", { name: "Verify…" });
    fireEvent.click(rows[rows.length - 1] as HTMLElement);

    // Not a confirmation with a warning in it — a refusal with an instruction.
    expect(screen.getByText(/Grant a membership first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify organisation" })).toBeNull();
  });
});
