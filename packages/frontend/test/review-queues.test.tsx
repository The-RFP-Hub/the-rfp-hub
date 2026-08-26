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
import type { DuplicatePair, Me, Opportunity, OrganizationSummary } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
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

vi.mock("next/link", () => ({
  default: ({ replace: shouldReplace, ...props }: ComponentProps<"a"> & { replace?: boolean }) => (
    <a {...props} data-replace={shouldReplace ? "true" : undefined} />
  ),
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
  mergedInto: null,
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
const duplicatePair: DuplicatePair = {
  id: 17,
  status: "suspected",
  similarity: 0.92,
  detectedAt: "2026-08-24T00:00:00Z",
  reviewedAt: null,
  left: {
    id: "acme:survivor",
    title: "Acme Grants",
    reviewStatus: "approved",
    isListed: true,
    namespace: "acme",
    mergedInto: null,
    updatedAt: "2026-08-24T00:00:00Z",
  },
  right: {
    id: "legacy:loser",
    title: "Legacy Acme Grants",
    reviewStatus: "approved",
    isListed: true,
    namespace: "legacy",
    mergedInto: null,
    updatedAt: "2026-08-24T00:00:00Z",
  },
};

const opportunity = (id: string, over: Partial<Opportunity> = {}): Opportunity =>
  ({
    specVersion: "1.0.0",
    id,
    fundingType: "grant",
    title: id,
    summary: null,
    description: `Description for ${id}.`,
    status: "open",
    applicationUrl: null,
    operatingOrganizations: [{ name: "Acme", slug: "acme" }],
    source: {},
    fundingDetails: { fundingType: "grant" },
    ...over,
  }) as Opportunity;

const approve = vi.fn(async () => ({ id: "x", reviewStatus: "approved", isListed: true }));
const reject = vi.fn(async () => ({ id: "x", reviewStatus: "rejected", isListed: false }));
const reviewOpportunity = vi.fn(async () => ({
  id: "indie:grant-1",
  title: "Indie Dev Grants",
  summary: "A grants round for independent maintainers.",
  applicationUrl: "https://indie.example.org/apply",
}));
const verifyOrganization = vi.fn(async () => verifiedOrg);
const verifySource = vi.fn(async () => ({
  runAt: "2026-08-25T12:00:00Z",
  requestedUrl: "https://indie.example.org/apply",
  finalUrl: "https://indie.example.org/apply",
  httpStatus: 200,
  existsAtSource: true,
  matched: true,
  fieldDiff: null,
  extracted: null,
  snapshotSha256: null,
  error: null,
}));
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

function client(account: Me = me): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: { get: async () => account },
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
      verifySource,
    },
  } as unknown as ApiClient;
}

const mount = (account: Me = me) =>
  render(
    <ApiClientProvider value={client(account)}>
      <ReviewPage />
    </ApiClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  tab.current = null;
});

describe("the section navigation", () => {
  it("carries each queue's count, so a reviewer sees the backlog before opening it", async () => {
    mount();

    expect(await screen.findByRole("link", { name: "Submissions · 7" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "Claims · 0" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "Duplicates · 0 open" })).toBeTruthy();
  });

  it("reads the open tab from the URL, so a link to one lands on it", async () => {
    tab.current = "organisations";
    mount();

    expect(
      await screen.findByRole("link", { name: "Organisations", current: "page" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Submissions/ }).hasAttribute("aria-current")).toBe(
      false,
    );
  });

  it("puts the section in the address and replaces rather than extending history", async () => {
    mount();

    const organisations = await screen.findByRole("link", { name: "Organisations" });
    expect(organisations.getAttribute("href")).toBe("/review?tab=organisations");
    expect(organisations.getAttribute("data-replace")).toBe("true");
  });
});

describe("deciding a submission", () => {
  it("can reach submissions after the first fifty rows", async () => {
    const requestedPages: number[] = [];
    const api = client();
    api.review.opportunities = async (query?: { page?: number; limit?: number }) => {
      const requested = query?.page ?? 1;
      requestedPages.push(requested);
      return {
        items: [
          {
            ...pending,
            id: `indie:grant-${requested}`,
            title: requested === 1 ? "First queue page" : "Submission fifty-one",
          },
        ],
        page: requested,
        limit: query?.limit ?? 50,
        total: 51,
        totalPages: 2,
      };
    };
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    const pager = await screen.findByRole("navigation", { name: "Submission queue pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));

    await waitFor(() => expect(requestedPages.at(-1)).toBe(2));
    const listing = await screen.findByRole("link", { name: "Submission fifty-one" });
    const href = new URL(listing.getAttribute("href") ?? "", "https://x.example");
    expect(href.searchParams.get("back")).toBe("/review?page=2");
    expect(replace).toHaveBeenCalledWith("/review?page=2");
  });

  it("returns to the new last page after deciding its final submission", async () => {
    const requestedPages: number[] = [];
    let decided = false;
    const api = client();
    api.review.approve = async () => {
      decided = true;
      return { id: "indie:grant-51", reviewStatus: "approved", isListed: true };
    };
    api.review.opportunities = async (query?: { page?: number; limit?: number }) => {
      const requested = query?.page ?? 1;
      requestedPages.push(requested);
      const finalPage = decided ? 1 : 2;
      return {
        items:
          requested > finalPage
            ? []
            : [
                {
                  ...pending,
                  id: requested === 1 ? "indie:grant-50" : "indie:grant-51",
                  title: requested === 1 ? "Last submission on page one" : "Submission fifty-one",
                },
              ],
        page: requested,
        limit: query?.limit ?? 50,
        total: decided ? 50 : 51,
        totalPages: finalPage,
      };
    };
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    const pager = await screen.findByRole("navigation", { name: "Submission queue pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Submission fifty-one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));

    await waitFor(() => expect(requestedPages.at(-1)).toBe(1));
    expect(await screen.findByText("Last submission on page one")).toBeTruthy();
    expect(screen.queryByText("Nothing waiting for review.")).toBeNull();
  });

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
    fireEvent.click(screen.getByRole("button", { name: /Check the source link/ }));
    expect(await screen.findByText(/Source response: page found/)).toBeTruthy();
    const technical = screen
      .getByText("Technical details")
      .closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(within(technical).getByText("HTTP status")).toBeTruthy();
    expect(within(technical).getByText("200")).toBeTruthy();
  });

  it("does not publish on the first click", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByText("Publish “Indie Dev Grants”?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("indie:grant-1"));
    expect(await screen.findByText("“Indie Dev Grants” is published.")).toBeTruthy();
  });

  it("requires a reason to refuse, and sends it", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    expect(screen.getByText("Refuse “Indie Dev Grants”?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refuse it" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/shown to whoever submitted it/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "the application link 404s" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse it" }));

    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith("indie:grant-1", "the application link 404s"),
    );
    expect(await screen.findByText("“Indie Dev Grants” was refused and unlisted.")).toBeTruthy();
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

    const submissions = await screen.findByRole("link", { name: /Submissions/ });
    expect(submissions.getAttribute("href")).toBe("/review");
    expect(submissions.getAttribute("data-replace")).toBe("true");

    const duplicates = screen.getByRole("link", { name: /Duplicates/ });
    expect(duplicates.getAttribute("href")).toBe("/review?tab=duplicates");
    expect(duplicates.getAttribute("data-replace")).toBe("true");
  });
});

describe("merging duplicates", () => {
  it("says the loser's public link will forward to the survivor", async () => {
    tab.current = "duplicates";
    const api = client();
    api.review.duplicates = async (query) => ({
      items: query?.status === "suspected" ? [duplicatePair] : [],
    });
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    const panel = screen.getByRole("group", { name: "Merge these two listings?" });
    expect(panel.textContent).toContain("Acme Grants — acme:survivor survives");
    expect(panel.textContent).toContain("Legacy Acme Grants — legacy:loser is rejected");
    expect(panel.textContent).toContain(
      "leaves the public directory and its public link forwards to the survivor",
    );
  });

  it("loads both open statuses with explicit limits, then filters and sorts the loaded page", async () => {
    tab.current = "duplicates";
    const requested: Array<{ status?: string; limit?: number } | undefined> = [];
    const api = client();
    api.review.duplicates = async (query) => {
      requested.push(query);
      if (query?.status === "suspected") {
        return {
          items: [
            {
              ...duplicatePair,
              id: 18,
              similarity: 0.84,
              left: { ...duplicatePair.left, title: "Below" },
            },
            {
              ...duplicatePair,
              id: 19,
              similarity: 0.88,
              left: { ...duplicatePair.left, title: "Second" },
            },
          ],
        };
      }
      if (query?.status === "confirmed") {
        return {
          items: [
            {
              ...duplicatePair,
              id: 20,
              status: "confirmed",
              similarity: 0.96,
              left: { ...duplicatePair.left, title: "First" },
            },
          ],
        };
      }
      return { items: [] };
    };
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByText("First")).toBeTruthy();
    expect(requested).toEqual(
      expect.arrayContaining([
        { status: "suspected", limit: 200 },
        { status: "confirmed", limit: 200 },
      ]),
    );
    expect(screen.queryByText("Below")).toBeNull();
    expect(screen.getByText(/2 of 3 open pairs loaded on this page/)).toBeTruthy();
    const visibleCards = document.querySelectorAll(".card");
    expect(visibleCards[0]?.textContent).toContain("First");
    expect(visibleCards[1]?.textContent).toContain("Second");

    fireEvent.click(screen.getByRole("button", { name: "1 below the threshold — show them" }));
    expect(screen.getByText("Below")).toBeTruthy();
  });

  it("fetches full descriptions lazily from the reviewer detail routes", async () => {
    tab.current = "duplicates";
    const api = client();
    const fetchOpportunity = vi.fn(async (id: string) =>
      id === duplicatePair.left.id
        ? opportunity(id, {
            title: duplicatePair.left.title,
            summary: "Current programme summary.",
            description: "Current programme description.",
            applicationUrl: "https://acme.example/apply",
          })
        : opportunity(id, {
            title: duplicatePair.right.title,
            fundingType: "rfp",
            summary: "Legacy programme summary.",
            description: "Legacy programme description.",
            applicationUrl: "https://legacy.example/apply",
          }),
    );
    api.review.opportunity = fetchOpportunity;
    api.review.duplicates = async (query) => ({
      items: query?.status === "suspected" ? [duplicatePair] : [],
    });
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    const compare = await screen.findByRole("button", { name: "Compare" });
    expect(fetchOpportunity).not.toHaveBeenCalled();
    fireEvent.click(compare);

    await waitFor(() =>
      expect(fetchOpportunity.mock.calls.map(([id]) => id)).toEqual([
        duplicatePair.left.id,
        duplicatePair.right.id,
      ]),
    );
    expect(await screen.findByText("Current programme description.")).toBeTruthy();
    expect(screen.getByText("Legacy programme description.")).toBeTruthy();
    expect(screen.getByText("https://acme.example/apply")).toBeTruthy();
    expect(screen.getAllByText("Different").length).toBeGreaterThan(0);
    expect(screen.getByText("Description").querySelector(".badge")).toBeNull();
  });

  it("keeps a dismissed row in place and reopens it through Undo", async () => {
    tab.current = "duplicates";
    const api = client();
    const dismiss = vi.fn(async () => ({
      ...duplicatePair,
      status: "dismissed" as const,
      reviewedAt: "2026-08-25T12:00:00Z",
    }));
    const reopen = vi.fn(async () => ({
      ...duplicatePair,
      status: "suspected" as const,
      reviewedAt: "2026-08-25T12:01:00Z",
    }));
    api.review.dismissDuplicate = dismiss;
    api.review.reopenDuplicate = reopen;
    api.review.duplicates = async (query) => ({
      items: query?.status === "suspected" ? [duplicatePair] : [],
    });
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByText("Acme Grants")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Duplicates · 0 open", current: "page" })).toBeTruthy();
    expect(screen.getByText("Decision saved.")).toBeTruthy();
    expect(screen.queryByText(/undo it from Recently resolved/i)).toBeNull();
    expect(dismiss).toHaveBeenCalledWith(duplicatePair.id);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Duplicates · 1 open", current: "page" })).toBeTruthy();
    expect(reopen).toHaveBeenCalledWith(duplicatePair.id);
  });

  it("keeps action slots stable across confirmation and dismissal", async () => {
    tab.current = "duplicates";
    const api = client();
    const confirm = vi.fn(async () => ({
      ...duplicatePair,
      status: "confirmed" as const,
      reviewedAt: "2026-08-25T12:00:00Z",
    }));
    const dismiss = vi.fn(async () => ({
      ...duplicatePair,
      status: "dismissed" as const,
      reviewedAt: "2026-08-25T12:01:00Z",
    }));
    api.review.confirmDuplicate = confirm;
    api.review.dismissDuplicate = dismiss;
    api.review.duplicates = async (query) => ({
      items: query?.status === "suspected" ? [duplicatePair] : [],
    });
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    const actionGroup = await screen.findByRole("group", {
      name: `Actions for pair ${duplicatePair.id}`,
    });
    const actionLabels = () =>
      within(actionGroup)
        .getAllByRole("button")
        .map((button) => button.textContent);

    expect(actionLabels()).toEqual(["Compare", "Confirm", "Dismiss", "Merge…"]);
    fireEvent.click(within(actionGroup).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Confirmed", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Acme Grants")).toBeTruthy();
    expect(actionLabels()).toEqual(["Compare", "Confirmed", "Dismiss", "Merge…"]);
    expect(within(actionGroup).getByRole("button", { name: "Confirmed" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("link", { name: "Duplicates · 1 open", current: "page" })).toBeTruthy();

    fireEvent.click(within(actionGroup).getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(actionLabels()).toEqual(["Compare", "Confirm", "Dismiss", "Merge…"]);
    expect(within(actionGroup).getByRole("button", { name: "Dismiss" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByText("Decision saved. Undo returns this pair to Needs review, not to Confirmed."),
    ).toBeTruthy();
    expect(dismiss).toHaveBeenCalledWith(duplicatePair.id);
  });

  it("marks merge busy, then keeps a receipt without inventing copied fields", async () => {
    tab.current = "duplicates";
    const api = client();
    const mergedPair = {
      ...duplicatePair,
      status: "merged" as const,
      reviewedAt: "2026-08-25T12:00:00Z",
      right: {
        ...duplicatePair.right,
        reviewStatus: "rejected" as const,
        isListed: false,
        mergedInto: duplicatePair.left.id,
      },
    };
    let finishMerge!: (result: {
      pair: DuplicatePair;
      survivorId: string;
      mergedId: string;
      copiedFields: string[];
    }) => void;
    const merge = vi.fn(
      () =>
        new Promise<{
          pair: DuplicatePair;
          survivorId: string;
          mergedId: string;
          copiedFields: string[];
        }>((resolve) => {
          finishMerge = resolve;
        }),
    );
    api.review.mergeDuplicate = merge;
    api.review.duplicates = async (query) => ({
      items: query?.status === "suspected" ? [duplicatePair] : [],
    });
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge them" }));

    expect(screen.getByRole("button", { name: "Merging…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Compare" })).toHaveProperty("disabled", true);

    await act(async () => {
      finishMerge({
        pair: mergedPair,
        survivorId: duplicatePair.left.id,
        mergedId: duplicatePair.right.id,
        copiedFields: [],
      });
    });

    expect(
      await screen.findByText((_, node) =>
        Boolean(
          node?.tagName === "STRONG" &&
            node.textContent?.includes(`Merged into ${duplicatePair.left.id} · view`),
        ),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "view" })).toBeTruthy();
    expect(screen.getByText("Acme Grants")).toBeTruthy();
    expect(screen.queryByText(/Copied fields: none/)).toBeNull();
    expect(screen.getByRole("link", { name: "Duplicates · 0 open", current: "page" })).toBeTruthy();
  });

  it("restores dismissed and merged receipts from the explicitly bounded resolved page", async () => {
    tab.current = "duplicates";
    const mergedPair: DuplicatePair = {
      ...duplicatePair,
      status: "merged",
      right: { ...duplicatePair.right, mergedInto: duplicatePair.left.id },
    };
    const dismissedPair: DuplicatePair = {
      ...duplicatePair,
      id: 18,
      status: "dismissed",
      reviewedAt: "2026-08-25T13:00:00Z",
      left: { ...duplicatePair.left, title: "Dismissed Acme Grants" },
    };
    const requested: Array<{ status?: string; limit?: number } | undefined> = [];
    const api = client();
    const reopen = vi.fn(async () => ({ ...dismissedPair, status: "suspected" as const }));
    api.review.reopenDuplicate = reopen;
    api.review.duplicates = async (query) => {
      requested.push(query);
      if (query?.status === "dismissed") return { items: [dismissedPair] };
      if (query?.status === "merged") return { items: [mergedPair] };
      return { items: [] };
    };
    render(
      <ApiClientProvider value={api}>
        <ReviewPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByText("Recently resolved")).toBeTruthy();
    expect(
      await screen.findByText((_, node) =>
        Boolean(
          node?.tagName === "STRONG" &&
            node.textContent?.includes(`Merged into ${duplicatePair.left.id} · view`),
        ),
      ),
    ).toBeTruthy();
    expect(screen.getByText("Dismissed Acme Grants")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/pair 18 · Needs review/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Duplicates · 1 open", current: "page" })).toBeTruthy();
    expect(reopen).toHaveBeenCalledWith(dismissedPair.id);
    expect(requested).toContainEqual({ status: "dismissed", limit: 200 });
    expect(requested).toContainEqual({ status: "merged", limit: 200 });
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

  it("links only organisations this reviewer belongs to", async () => {
    mount({
      ...me,
      memberships: [
        { slug: "filecoin", name: "Filecoin Foundation", role: "publisher", verified: true },
      ],
    });

    const memberLink = await screen.findByRole("link", { name: "Filecoin Foundation" });
    expect(memberLink.getAttribute("href")).toBe("/organisations/filecoin");
    expect(screen.getByText("Indie Collective").closest("a")).toBeNull();
  });

  it("hides directory stubs until somebody searches for one", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());
    expect(screen.getByLabelText(/Search organisations/).closest("form")?.className).toBe(
      "search-row",
    );
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
    expect(
      await screen.findByText(
        "indie-collective is verified — its 1 member now publishes into that namespace without review.",
      ),
    ).toBeTruthy();
  });

  it("grants a membership, resolving the handle the reviewer knows to the id the API wants", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());

    // By ROW: the Verified section renders first, so "the first Grant button" is Filecoin's.
    const row = screen.getByText("Indie Collective").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Grant a membership…" }));
    expect(screen.getByLabelText("Account handle or id").closest(".filters")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Account handle or id"), {
      target: { value: "fil-ops" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));

    // The API takes an integer account id; a reviewer reading a claim knows the handle.
    await waitFor(() => expect(accounts).toHaveBeenCalledWith({ q: "fil-ops", limit: 10 }));
    expect(await screen.findByText("1 account matches “fil-ops”.")).toBeTruthy();
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
    expect(
      await screen.findByText("fil-ops is now an organisation publisher at indie-collective."),
    ).toBeTruthy();
    // The panel is gone; the note is not.
    expect(screen.queryByText("Grant a membership on")).toBeNull();
  });

  it("pluralises account matches and omits an empty candidate table", async () => {
    accounts
      .mockResolvedValueOnce({
        items: [
          {
            id: 42,
            handle: "fil-ops",
            displayName: null,
            globalRole: "submitter",
            directCreate: false,
            createdAt: "2026-02-01T00:00:00Z",
          },
          {
            id: 43,
            handle: "fil-ops-two",
            displayName: null,
            globalRole: "submitter",
            directCreate: false,
            createdAt: "2026-02-02T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] });
    mount();
    await waitFor(() => expect(screen.getByText("Indie Collective")).toBeTruthy());
    const row = screen.getByText("Indie Collective").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Grant a membership…" }));

    fireEvent.change(screen.getByLabelText("Account handle or id"), {
      target: { value: "fil-ops" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));
    expect(await screen.findByText("2 accounts match “fil-ops”.")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Account" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Account handle or id"), {
      target: { value: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));
    expect(await screen.findByText("No account matches “missing”.")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Account" })).toBeNull();
  });

  it("states the consequence differently for a verified organisation", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Filecoin Foundation")).toBeTruthy());

    const row = screen.getByText("Filecoin Foundation").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Grant a membership…" }));
    fireEvent.change(screen.getByLabelText("Account handle or id"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Find the account" }));

    const panel = await screen.findByRole("group", {
      name: /Make account 42 an organisation publisher/,
    });
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
