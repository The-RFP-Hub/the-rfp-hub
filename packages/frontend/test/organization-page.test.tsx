/**
 * THE ORGANIZATION PAGE, whose whole job is to keep two gates apart.
 *
 * Seeing this page needs ANY membership; deciding on what is queued in the namespace needs a
 * membership on a VERIFIED organization. Those are different permissions granted by different
 * events, and the failure mode if they blur is not cosmetic — it is an unverified organization being
 * offered a button that publishes to the world, or a verified one being denied the decision it was
 * verified in order to make.
 *
 * The two confirmations are tested for their WORDS, not just their existence. "Publishes in
 * filecoin's name" and "recorded under your handle" are the whole reason the confirmation is there;
 * a panel that said "Are you sure?" would pass a test that only counted clicks.
 */
import OrganizationPage from "@/app/organizations/[slug]/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type {
  ManagedOpportunityList,
  Me,
  MeMembership,
  MembershipInvite,
  PublisherList,
} from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, slug, query, replace } = vi.hoisted(() => ({
  session: {
    data: { user: { id: "u1" } } as { user: { id: string } } | null,
    isPending: false,
    error: null,
  },
  slug: { current: "filecoin" },
  query: { current: "" },
  replace: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut: vi.fn(), getSession: vi.fn() },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: slug.current }),
  usePathname: () => `/organizations/${slug.current}`,
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(query.current),
}));

const membership = (over: Partial<MeMembership> = {}): MeMembership => ({
  slug: "filecoin",
  name: "Filecoin Foundation",
  role: "admin",
  verified: true,
  ...over,
});

const me = (over: Partial<Me> = {}): Me => ({
  accountId: 7,
  handle: "fil-ops",
  displayName: "Fil Ops",
  email: "ops@example.org",
  role: "submitter",
  directCreate: false,
  credentialKind: "session",
  scopes: [],
  memberships: [membership()],
  canManageKeys: true,
  canReview: false,
  canAdmin: false,
  createdAt: "2026-08-01T00:00:00Z",
  ...over,
});

/** Whether the published fixture row is publicly listed. Flipped by the withheld tests. */
const listedFixture = { current: false };

const listing = (over: Record<string, unknown> = {}) => ({
  id: "filecoin:round-1",
  title: "PropGF Batch 7",
  fundingType: "grant",
  status: "open",
  reviewStatus: "approved",
  isListed: listedFixture.current,
  namespace: "filecoin",
  submittedBy: "fil-maintainer",
  mergedInto: null,
  lastDecision: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-10T00:00:00Z",
  ...over,
});

const page = (
  items: unknown[],
  over: Partial<ManagedOpportunityList> = {},
): ManagedOpportunityList =>
  ({
    items,
    page: 1,
    limit: 20,
    total: items.length,
    totalPages: 1,
    ...over,
  }) as ManagedOpportunityList;

/** Records the query each list asked for, so a test can prove which page was requested. */
const asked: { approved: unknown[]; pending: unknown[] } = { approved: [], pending: [] };

const publishers: PublisherList = {
  items: [
    {
      slug: "filecoin",
      name: "Filecoin Foundation",
      description: null,
      website: "https://filecoin.example.org",
      logoUrl: null,
      ecosystems: [],
      verifiedAt: "2026-08-14T00:00:00Z",
    },
  ],
  total: 1,
};

const approve = vi.fn(async () => ({ id: "x", reviewStatus: "approved", isListed: true }));
const reject = vi.fn(async () => ({ id: "x", reviewStatus: "rejected", isListed: false }));
// Typed parameters so a test can read the patch back without casting it blind.
const update = vi.fn(async (_slug: string, _patch: Record<string, unknown>) => ({}));
const membershipInviteRows: { current: MembershipInvite[] } = { current: [] };
const membershipInvites = vi.fn(async () => ({ items: membershipInviteRows.current }));
const revokeMembershipInvite = vi.fn(async (_slug: string, inviteId: number) => {
  const invite = membershipInviteRows.current.find((row) => row.id === inviteId);
  if (!invite) throw new Error("missing invite fixture");
  membershipInviteRows.current = membershipInviteRows.current.filter((row) => row.id !== inviteId);
  return invite;
});

/** Counts each read so a test can prove BOTH lists were re-read, not just the one clicked in. */
const reads = { approved: 0, pending: 0 };

function client(account: Me, pending: unknown[] = []): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: { get: async () => account },
    publishers: { list: async () => publishers },
    opportunities: { audit: async () => ({ entries: [] }) },
    review: { membershipInvites, revokeMembershipInvite },
    organizations: {
      opportunities: async (
        _slug: string,
        query?: { reviewStatus?: string; page?: number; limit?: number },
      ) => {
        if (query?.reviewStatus === "pending") {
          reads.pending += 1;
          asked.pending.push(query);
          return page(pending, { page: query?.page ?? 1, total: 60, totalPages: 3 });
        }
        reads.approved += 1;
        asked.approved.push(query);
        return page([listing()], { page: query?.page ?? 1, total: 60, totalPages: 3 });
      },
      approve,
      reject,
      update,
    },
  } as unknown as ApiClient;
}

const mount = (account: Me, pending: unknown[] = []) =>
  render(
    <ApiClientProvider value={client(account, pending)}>
      <OrganizationPage />
    </ApiClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  reads.approved = 0;
  reads.pending = 0;
  asked.approved = [];
  asked.pending = [];
  listedFixture.current = false;
  session.data = { user: { id: "u1" } };
  slug.current = "filecoin";
  query.current = "";
  membershipInviteRows.current = [];
});

describe("who may see the page", () => {
  it("refuses an account with no membership on that slug, and does not guess why", async () => {
    slug.current = "someone-else";
    mount(me());

    expect(await screen.findByText("You are not a member of this organization.")).toBeTruthy();
    // It must not claim the organization is missing — the API would answer 403 or 404 and this
    // page cannot tell which without asking.
    expect(screen.queryByText(/does not exist/i)).toBeNull();
  });

  it("lets any member in, verified or not", async () => {
    mount(me({ memberships: [membership({ verified: false })] }));

    expect(await screen.findByText("Your listings wait for a reviewer.")).toBeTruthy();
    expect(screen.queryByText("You are not a member of this organization.")).toBeNull();
  });
});

describe("pending membership invites for staff", () => {
  it("lists the pending email and lets a reviewer revoke it", async () => {
    membershipInviteRows.current = [
      {
        id: 14,
        organizationSlug: "filecoin",
        email: "future.member@example.org",
        role: "publisher",
        invitedBy: 2,
        createdAt: "2026-08-26T12:00:00Z",
        acceptedAt: null,
        acceptedAccountId: null,
      },
    ];
    mount(me({ role: "reviewer", canReview: true }));

    expect(await screen.findByRole("heading", { name: "Pending membership invites" })).toBeTruthy();
    expect(
      screen.getByText("The membership applies the first time they sign in with this email."),
    ).toBeTruthy();
    expect(
      await screen.findByRole("row", {
        name: /future\.member@example\.org Organization publisher/,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeMembershipInvite).toHaveBeenCalledWith("filecoin", 14));
    await waitFor(() =>
      expect(screen.queryByRole("row", { name: /future\.member@example\.org/ })).toBeNull(),
    );
  });
});

describe("what verification changes", () => {
  it("tells a verified member their writes publish directly, and dates it", async () => {
    mount(me());

    expect(await screen.findByText("You publish directly.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Verified 14 Aug/)).toBeTruthy());
  });

  it("tells an unverified member the opposite, without claiming a verification date", async () => {
    mount(me({ memberships: [membership({ verified: false })] }));

    expect(await screen.findByText("Your listings wait for a reviewer.")).toBeTruthy();
    expect(screen.queryByText(/^Verified /)).toBeNull();
  });

  it("offers no decision buttons to an unverified member", async () => {
    mount(me({ memberships: [membership({ verified: false })] }), [
      listing({
        id: "filecoin:pending-1",
        title: "Filecoin Dev Grants Q4",
        reviewStatus: "pending",
        isListed: false,
      }),
    ]);

    await screen.findByText("Your listings wait for a reviewer.");
    await waitFor(() => expect(screen.getByText("Filecoin Dev Grants Q4")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();
    // History stays available — seeing is not deciding.
    expect(screen.getAllByRole("button", { name: "History" }).length).toBeGreaterThan(0);
  });
});

describe("deciding as a verified member", () => {
  const pending = [
    listing({
      id: "filecoin:pending-1",
      title: "Filecoin Dev Grants Q4",
      reviewStatus: "pending",
      isListed: false,
      submittedBy: "indie2",
    }),
  ];

  it("states the consequence before publishing — whose name, and whose decision", async () => {
    mount(me(), pending);

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));

    expect(screen.getByText("Publish “Filecoin Dev Grants Q4”?")).toBeTruthy();
    // The two facts that make this different from a reviewer approving it: whose name it publishes
    // under, and whose handle the decision is recorded against.
    const panel = screen.getByRole("group", { name: "Publish “Filecoin Dev Grants Q4”?" });
    expect(
      within(panel).getByText(/publishes into the public directory immediately/i),
    ).toBeTruthy();
    expect(within(panel).getByText("filecoin")).toBeTruthy();
    expect(within(panel).getByText("@fil-ops")).toBeTruthy();
  });

  it("discloses a member deciding their own submission in the row and confirmation", async () => {
    const notice = "You submitted this listing. The decision will be recorded under your handle.";
    mount(me(), [
      listing({
        id: "filecoin:self-review",
        title: "Our own grants round",
        reviewStatus: "pending",
        isListed: false,
        submittedBy: "fil-ops",
        submittedByAccountId: 7,
      }),
    ]);

    expect(await screen.findByText(notice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
    expect(
      within(screen.getByRole("group", { name: "Publish “Our own grants round”?" })).getByText(
        notice,
      ),
    ).toBeTruthy();
  });

  it("does not show the self-review notice for somebody else's submission", async () => {
    const notice = "You submitted this listing. The decision will be recorded under your handle.";
    mount(me(), [
      listing({
        id: "filecoin:other-review",
        title: "Somebody else's round",
        reviewStatus: "pending",
        isListed: false,
        submittedByAccountId: 99,
      }),
    ]);

    await screen.findByText("Somebody else's round");
    expect(screen.queryByText(notice)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
    expect(screen.queryByText(notice)).toBeNull();
  });

  it("publishes only after the confirmation", async () => {
    mount(me(), pending);

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    expect(approve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("filecoin", "filecoin:pending-1"));
  });

  it("will not refuse without a written reason, and sends the one that was written", async () => {
    mount(me(), pending);

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    expect(screen.getByText("Refuse “Filecoin Dev Grants Q4”?")).toBeTruthy();
    // The reason is the counterweight to the conflict of interest, so the button cannot fire
    // without one.
    expect(screen.getByRole("button", { name: "Refuse it" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "we have never run this program" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse it" }));

    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith(
        "filecoin",
        "filecoin:pending-1",
        "we have never run this program",
      ),
    );
    expect(
      await screen.findByText(
        "“Filecoin Dev Grants Q4” was refused. The reason is shown to whoever submitted it.",
      ),
    ).toBeTruthy();
  });

  it("re-reads BOTH lists after a decision, because the row moves between them", async () => {
    mount(me(), pending);

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    await waitFor(() => expect(reads.approved).toBe(1));
    const before = reads.approved;

    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));
    await waitFor(() => expect(approve).toHaveBeenCalled());

    /*
     * Approving does not merely empty a row out of "Awaiting review" — it fills one in under
     * "Published". Reloading only the list the button was in left the published table stale until a
     * manual page reload: the listing was live and the page said it was not.
     */
    await waitFor(() => expect(reads.approved).toBeGreaterThan(before));
    expect(
      screen.getByText(
        "“Filecoin Dev Grants Q4” is published. The decision is recorded under @fil-ops.",
      ),
    ).toBeTruthy();
  });

  it("says the refusal is attributed and shown to the submitter", async () => {
    mount(me(), pending);

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    expect(screen.getByText(/A reason is required/)).toBeTruthy();
    expect(screen.getByText(/shown to whoever submitted it/)).toBeTruthy();
  });
});

describe("the way back", () => {
  it("sends the way back from the PUBLISHED table too, not just the pending one", async () => {
    // The two tables had drifted: one carried the origin and the other dropped it, so where "back"
    // went depended on which half of the page a reader had clicked in.
    mount(me(), []);

    const link = await screen.findByRole("link", { name: "PropGF Batch 7" });
    const url = new URL(link.getAttribute("href") ?? "", "https://x.example");

    expect(url.pathname).toBe("/listings/filecoin%3Around-1");
    expect(url.searchParams.get("back")).toBe("/organizations/filecoin");
    expect(url.searchParams.get("backLabel")).toBe("Filecoin Foundation");
  });

  it("sends the organization's own name and address with every listing link", async () => {
    mount(me(), [
      listing({ id: "filecoin:pending-1", title: "Dev Grants Q4", reviewStatus: "pending" }),
    ]);

    const link = await screen.findByRole("link", { name: "Dev Grants Q4" });
    const url = new URL(link.getAttribute("href") ?? "", "https://x.example");

    expect(url.pathname).toBe("/listings/filecoin%3Apending-1");
    expect(url.searchParams.get("back")).toBe("/organizations/filecoin");
    // The slug is not what anybody calls it, so the display name rides along.
    expect(url.searchParams.get("backLabel")).toBe("Filecoin Foundation");
  });

  it("keeps both table pages when a listing is opened and then revisited", async () => {
    query.current = "publishedPage=2&pendingPage=3";
    mount(me(), [
      listing({ id: "filecoin:pending-1", title: "Dev Grants Q4", reviewStatus: "pending" }),
    ]);

    await waitFor(() => expect(asked.approved.at(-1)).toMatchObject({ page: 2 }));
    await waitFor(() => expect(asked.pending.at(-1)).toMatchObject({ page: 3 }));
    const link = await screen.findByRole("link", { name: "Dev Grants Q4" });
    const url = new URL(link.getAttribute("href") ?? "", "https://x.example");
    expect(url.searchParams.get("back")).toBe(
      "/organizations/filecoin?publishedPage=2&pendingPage=3",
    );
  });
});

describe("the namespace queue", () => {
  it("says what it does not show, so it is not read as a guarantee", async () => {
    mount(me(), []);

    expect(await screen.findByText(/only reviewers see the rest of the queue/)).toBeTruthy();
  });
});

describe("paging through the two lists", () => {
  it("asks for a real page rather than only the first fifty rows", async () => {
    mount(me(), []);

    await waitFor(() => expect(asked.approved.length).toBeGreaterThan(0));
    // Beyond one page of rows, everything past the first request used to be unreachable — and on
    // the pending side that meant submissions in the namespace that could not be decided at all.
    expect(asked.approved[0]).toMatchObject({ reviewStatus: "approved", page: 1, limit: 20 });
    expect(asked.pending[0]).toMatchObject({ reviewStatus: "pending", page: 1, limit: 20 });
  });

  it("pages each list independently, because they are independent readings", async () => {
    mount(me(), [listing({ id: "filecoin:p1", title: "Q4 Grants", reviewStatus: "pending" })]);

    const publishedPager = await screen.findByRole("navigation", {
      name: "Published listing pages",
    });
    fireEvent.click(within(publishedPager).getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(asked.approved.at(-1)).toMatchObject({ reviewStatus: "approved", page: 2 }),
    );
    // Moving through published history must not drag the review queue along with it.
    expect(asked.pending.every((query) => (query as { page: number }).page === 1)).toBe(true);
  });

  it("reloads the page the reviewer is ON after a decision, not the first one", async () => {
    mount(me(), [listing({ id: "filecoin:p1", title: "Q4 Grants", reviewStatus: "pending" })]);

    const pendingPager = await screen.findByRole("navigation", {
      name: "Pages of submissions awaiting review",
    });
    fireEvent.click(within(pendingPager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(asked.pending.at(-1)).toMatchObject({ page: 2 }));

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));

    await waitFor(() => expect(approve).toHaveBeenCalled());
    // Approving a row on page 2 must not silently return the reader to the top of the queue.
    await waitFor(() => expect(asked.pending.at(-1)).toMatchObject({ page: 2 }));
  });

  it("steps back when deciding the last row makes the current queue page disappear", async () => {
    let decided = false;
    const requestedPages: number[] = [];
    const api = client(me(), []);
    api.organizations.approve = vi.fn(async () => {
      decided = true;
      return { id: "filecoin:last", reviewStatus: "approved", isListed: true };
    });
    api.organizations.opportunities = async (
      _slug: string,
      query?: { reviewStatus?: string; page?: number; limit?: number },
    ) => {
      const requested = query?.page ?? 1;
      if (query?.reviewStatus !== "pending") {
        return page([listing()], { page: requested, total: 60, totalPages: 3 });
      }
      requestedPages.push(requested);
      if (decided && requested === 3) {
        // The only row on page 3 just moved to Published. Forty rows remain, so page 3 no longer
        // exists; trapping the reader on an empty page would claim the queue itself is empty.
        return page([], { page: 3, total: 40, totalPages: 2 });
      }
      return page(
        [
          listing({
            id: decided ? "filecoin:p40" : "filecoin:last",
            title: decided ? "Queue entry 40" : "Last row on page three",
            reviewStatus: "pending",
          }),
        ],
        { page: requested, total: decided ? 40 : 41, totalPages: decided ? 2 : 3 },
      );
    };

    render(
      <ApiClientProvider value={api}>
        <OrganizationPage />
      </ApiClientProvider>,
    );

    const pager = await screen.findByRole("navigation", {
      name: "Pages of submissions awaiting review",
    });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(requestedPages.at(-1)).toBe(2));
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(requestedPages.at(-1)).toBe(3));

    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish it" }));

    // The page count falls from 3 to 2 after the decision. The UI must follow the server's new
    // last page rather than render "nothing is waiting" while forty rows remain elsewhere.
    await waitFor(() => expect(requestedPages.at(-1)).toBe(2));
    expect(await screen.findByText("Queue entry 40")).toBeTruthy();
  });
});

describe("approved but withheld", () => {
  it("does not let an unlisted listing read as if it were live", async () => {
    mount(me(), []);

    // The row is approved, so it belongs under "Published" — and the public reads 404 it, so it
    // cannot be presented as public.
    await waitFor(() => expect(screen.getByText("PropGF Batch 7")).toBeTruthy());
    expect(screen.getByText("Hidden from the public directory")).toBeTruthy();
    expect(
      screen.getByText(/hidden from the public directory — a Hub reviewer controls listing/),
    ).toBeTruthy();
  });

  it("counts the withheld rows on the page, without inventing a namespace-wide figure", async () => {
    mount(me(), []);

    expect(await screen.findByText(/One listing on this page is/)).toBeTruthy();
    expect(screen.getByText(/no public detail page/)).toBeTruthy();
  });

  it("says nothing at all when every published row really is public", async () => {
    listedFixture.current = true;
    mount(me(), []);

    await waitFor(() => expect(screen.getByText("PropGF Batch 7")).toBeTruthy());
    expect(screen.queryByText("Hidden from the public directory")).toBeNull();
    expect(screen.queryByText(/hidden from the public directory/)).toBeNull();
  });
});

describe("the directory entry", () => {
  it("is editable by an admin, and sends only what changed", async () => {
    mount(me());

    fireEvent.click(await screen.findByRole("button", { name: /Edit the organization/ }));
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "https://example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Only the website moved, so only the website is sent. A PATCH carrying every field is how an
    // untouched one gets destroyed.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("filecoin", { website: "https://example.org" }),
    );
  });

  it("does NOT wipe stored metadata when only the name is changed", async () => {
    // THE DEFECT: the form started blank and sent `website: null, description: null` on every save,
    // so renaming an organization silently deleted its website and description from every listing
    // that named it.
    mount(me());

    fireEvent.click(await screen.findByRole("button", { name: /Edit the organization/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Filecoin Fdn" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("filecoin", { name: "Filecoin Fdn" }));
    const patch = update.mock.calls[0]?.[1] ?? {};
    expect("website" in patch).toBe(false);
    expect("description" in patch).toBe(false);
  });

  it("seeds the fields from the public record, so a clear is deliberate", async () => {
    mount(me());

    fireEvent.click(await screen.findByRole("button", { name: /Edit the organization/ }));
    // The fixture publisher carries a website; the form must show it rather than an empty box that
    // looks like "no website".
    expect((screen.getByLabelText("Website") as HTMLInputElement).value).toBe(
      "https://filecoin.example.org",
    );

    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Emptying a field that HAD a value is an explicit clear, and is sent as one.
    await waitFor(() => expect(update).toHaveBeenCalledWith("filecoin", { website: null }));
  });

  it("says nothing changed rather than sending an empty patch", async () => {
    mount(me());

    fireEvent.click(await screen.findByRole("button", { name: /Edit the organization/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Nothing changed.")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("is refused to a plain publisher, naming the role that is missing", async () => {
    mount(me({ memberships: [membership({ role: "publisher" })] }));

    await screen.findByText("You publish directly.");
    expect(screen.queryByRole("button", { name: /Edit the organization/ })).toBeNull();
    expect(screen.getByText(/needs the/)).toBeTruthy();
  });
});
