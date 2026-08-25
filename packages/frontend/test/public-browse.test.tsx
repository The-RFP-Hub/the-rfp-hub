/**
 * THE PUBLIC HALF, PROVEN RATHER THAN EYEBALLED.
 *
 * These two surfaces are the ones a visitor with no account reaches, so three things about them
 * have to be true and none of them is visible in an API test:
 *
 *   1. They read the PUBLIC routes. `GET /v1/opportunities/{id}` is where the API counts a detail
 *      view and `/v1/r/{id}/apply` is where it counts an apply click, so a page that fetched or
 *      linked anywhere else would leave a publisher's numbers at zero while people read and applied.
 *      Both are asserted against the client's recorded calls and the rendered `href`.
 *   2. They render the fields the payload actually carries — a Standard opportunity, whose deadlines
 *      are an array and whose money is an envelope, not a pair of scalars.
 *   3. They render publisher-supplied strings as TEXT. This is the surface an anonymous visitor
 *      reaches without having decided to trust anyone, so the fixture titles below carry markup and
 *      the assertions insist it stays inert.
 *
 * The API client is injected through the same context the application uses, so the components fetch,
 * await and render exactly as they do in a browser. No network, no auth SDK, no database.
 */
import { DirectoryList } from "@/components/DirectoryList";
import { PublicOpportunity } from "@/components/PublicOpportunity";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { AuditTrail, Me, Opportunity, PaginatedOpportunities } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ADDRESS BAR, STUBBED, because it is now where the directory's filter state lives.
 *
 * `navigation.params` is what `useSearchParams()` answers — set it to render the directory as a
 * reader arriving on that URL would see it — and `navigation.push` records what a control asked
 * the browser to navigate to. Together they are the whole contract: what the URL says is what is
 * shown, and what a control does is change the URL.
 */
const { navigation, authSession } = vi.hoisted(() => ({
  navigation: { params: new URLSearchParams(), push: vi.fn() },
  authSession: {
    data: null as { user: { id: string } } | null,
    isPending: false,
    error: null as { status?: number; message?: string } | null,
  },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => authSession,
    signOut: vi.fn(),
    getSession: vi.fn(),
  },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => navigation.params,
  usePathname: () => "/",
}));

const BASE_URL = "https://api.example.com";

/** A title nobody would type by accident, and exactly what an injection attempt looks like. */
const HOSTILE_TITLE = '<img src=x onerror="alert(1)">Retro Funding Round Four';

const page: PaginatedOpportunities = {
  items: [
    {
      specVersion: "1.0.0",
      id: "acme:round-4",
      fundingType: "grant",
      title: HOSTILE_TITLE,
      description: "Grants for public-goods infrastructure.",
      summary: "One round, quarterly.",
      status: "open",
      operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
      source: { publisher: "acme", submittedBy: "acme", verifiedAgainstSource: true },
      ecosystems: ["Optimism", "Base"],
      fundingInfo: { currency: "USD", minAward: 5000, maxAward: 50000 },
      deadlines: [
        { deadlineType: "fixed", date: "2099-09-30T23:59:00Z", label: "application" },
        { deadlineType: "fixed", date: "2099-12-01T00:00:00Z", label: "final report" },
      ],
    },
    {
      specVersion: "1.0.0",
      id: "beta:bounty-1",
      fundingType: "bounty",
      title: "Continuous Disclosure Programme",
      description: "A standing programme.",
      status: "open",
      operatingOrganizations: [{ name: "Beta Collective", slug: "beta" }],
      source: {},
      deadlines: [{ deadlineType: "rolling" }],
    },
  ],
  page: 1,
  limit: 20,
  total: 2,
  totalPages: 1,
};

const entry: Opportunity = {
  specVersion: "1.0.0",
  id: "acme:round-4",
  fundingType: "grant",
  title: HOSTILE_TITLE,
  description: "Grants for public-goods infrastructure, paid against milestones.",
  summary: "One round, quarterly.",
  status: "open",
  operatingOrganizations: [
    { name: "Acme Foundation", slug: "acme", website: "https://acme.example.com" },
  ],
  sponsoringOrganizations: [{ name: "Beta Collective", slug: "beta" }],
  source: {
    publisher: "acme",
    submittedBy: "acme",
    submittedAt: "2026-08-01T09:00:00Z",
    ingestedVia: "publisher_api",
    originalId: "R4",
    verifiedAgainstSource: true,
    verifiedAt: "2026-08-10T09:00:00Z",
    snapshotUrl: "https://archive.example.com/r4",
  },
  ecosystems: ["Optimism"],
  categories: ["infrastructure"],
  eligibility: "Teams shipping open-source infrastructure.",
  applicationUrl: "https://acme.example.com/apply",
  website: "https://acme.example.com",
  fundingInfo: { currency: "USD", minAward: 5000, maxAward: 50000, allocated: 120000 },
  milestones: [{ title: "Testnet launch", amount: 25000, criteria: "Deployed and documented." }],
  deadlines: [{ deadlineType: "fixed", date: "2099-09-30T23:59:00Z", label: "application" }],
  opensAt: "2026-08-01T00:00:00Z",
  postedAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
  fundingDetails: { fundingType: "grant", milestoneBased: true },
};

const trail: AuditTrail = {
  entries: [
    {
      action: "replace",
      at: "2026-08-12T00:00:00Z",
      actorKind: "publisher",
      actor: "acme",
      changedFields: ["deadlines", "fundingInfo"],
    },
  ],
};

interface Stub {
  client: ApiClient;
  list: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
}

function stub(overrides?: {
  list?: () => Promise<PaginatedOpportunities>;
  find?: () => Promise<Opportunity>;
  audit?: () => Promise<AuditTrail>;
}): Stub {
  const list = vi.fn(overrides?.list ?? (async () => page));
  const find = vi.fn(overrides?.find ?? (async () => entry));
  const audit = vi.fn(overrides?.audit ?? (async () => trail));
  return {
    client: {
      baseUrl: BASE_URL,
      directory: { list, find },
      opportunities: { audit },
    } as unknown as ApiClient,
    list,
    find,
    audit,
  };
}

const mount = (client: ApiClient, children: React.ReactNode) =>
  render(<ApiClientProvider value={client}>{children}</ApiClientProvider>);

describe("the public directory list", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
    navigation.push.mockClear();
  });

  it("says it is loading before it says anything else", () => {
    const { client } = stub({ list: () => new Promise(() => {}) });
    mount(client, <DirectoryList />);

    expect(screen.getByText(/Loading the directory/)).toBeTruthy();
  });

  it("reads the public list route, with only parameters that route declares", async () => {
    const { client, list } = stub();
    mount(client, <DirectoryList />);

    await screen.findByText("Acme Foundation");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toEqual({
      q: undefined,
      fundingType: undefined,
      // THE DEFAULT NARROWS, and it goes on the wire as a real filter rather than being applied in
      // the browser. A public register of funding opens on what a reader can still apply to.
      status: "open",
      ecosystem: undefined,
      sort: "nextDeadlineAt",
      order: "asc",
      page: 1,
      limit: 20,
    });
  });

  it("renders the default filter IN THE CONTROL, not silently behind it", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);

    await screen.findByText("Acme Foundation");
    // A narrowing a reader cannot see is a narrowing they cannot undo — which is the whole
    // objection to a hidden default, and the reason this assertion exists next to the one above.
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(status.value).toBe("open");
    expect(screen.getByRole("link", { name: "Include closed and upcoming" })).toBeTruthy();
  });

  it("renders the fields the thin list projection actually carries", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);

    // Title, and the publisher's own summary line under it — which is what replaced the raw id.
    expect(await screen.findByText(HOSTILE_TITLE)).toBeTruthy();
    expect(screen.getByText("One round, quarterly.")).toBeTruthy();

    // THE RAW ID IS GONE FROM THE ROW. It is a join key: widest thing in the cell, sitting in the
    // position a scanning eye reads second, and telling a reader nothing about whether to click.
    expect(screen.queryByText("acme:round-4")).toBeNull();

    // The operating organisation — entry 0, the party that runs the intake.
    expect(screen.getByText("Acme Foundation")).toBeTruthy();

    // Status is its own column now, as a word. Scoped to the badge, because "open" is also an
    // option in the Status control — which is exactly the point of that control being visible.
    expect(screen.getAllByText("open", { selector: ".badge" })).toHaveLength(2);

    // The next FIXED deadline, derived from the array, not the last entry in it.
    expect(screen.getByText("30 Sep 23:59 UTC")).toBeTruthy();
    // A rolling-only record says so rather than showing a blank.
    expect(screen.getByText("Rolling")).toBeTruthy();

    // The count line names the narrowing it is describing.
    expect(screen.getByText(/2 open opportunities/)).toBeTruthy();
    expect(screen.getByText(/page 1 of 1/)).toBeTruthy();
  });

  it("carries status as a shape and a word, never as a colour", async () => {
    const closed: PaginatedOpportunities = {
      ...page,
      items: [{ ...page.items[0], status: "closed" } as (typeof page.items)[number]],
      total: 1,
    };
    const { client } = stub({ list: async () => closed });
    const { container } = mount(client, <DirectoryList />);

    const badge = await screen.findByText("closed", { selector: ".badge" });
    // The class is the whole carrier — the stylesheet turns it into a filled box, and a reader who
    // sees no colour at all reads the same word. No inline colour anywhere near it.
    expect(badge.className).toContain("badge-closed");
    expect(badge.getAttribute("style")).toBeNull();
    expect(container.querySelector("[class*='badge'][style]")).toBeNull();
  });

  it("links each row at the public detail page, id-encoded", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);

    const link = await screen.findByRole("link", { name: HOSTILE_TITLE });
    expect(link.getAttribute("href")).toBe("/opportunities/acme%3Around-4");
  });

  it("renders a publisher's markup as text, never as markup", async () => {
    const { client } = stub();
    const { container } = mount(client, <DirectoryList />);

    await screen.findByText(HOSTILE_TITLE);
    // No element was created from it, and the source shows why: the angle brackets are escaped, so
    // the browser parsed a string rather than a tag with an event handler on it.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img src=x");
  });

  it("distinguishes an empty directory from an empty filter result", async () => {
    const empty: PaginatedOpportunities = {
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    };

    // Nothing at all, seen with every filter off: the honest answer is that nothing is published.
    navigation.params = new URLSearchParams("status=any");
    const { client } = stub({ list: async () => empty });
    const first = mount(client, <DirectoryList />);
    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
    first.unmount();

    // The same empty payload under the DEFAULT view is a different sentence, because the default
    // is itself a filter. Telling a reader who narrowed to open grants that nothing has ever been
    // published here would be a lie, and it would hide the one control that fixes it.
    navigation.params = new URLSearchParams();
    mount(client, <DirectoryList />);
    expect(await screen.findByText("Nothing matches those filters.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear the filters" })).toBeTruthy();
  });

  it("offers the reader a next step from an empty directory rather than a dead end", async () => {
    const empty: PaginatedOpportunities = {
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    };
    navigation.params = new URLSearchParams("status=any");
    const { client } = stub({ list: async () => empty });
    mount(client, <DirectoryList />);

    await screen.findByText("Nothing published yet.");
    const invitation = screen.getByRole("link", { name: "Do you run a programme?" });
    expect(invitation.getAttribute("href")).toBe("/how-it-works");
  });

  it("shows the API's own failure rather than an empty table", async () => {
    const { client } = stub({
      list: async () => {
        throw new ApiError(
          400,
          "validation_failed",
          "querystring must NOT have additional properties",
        );
      },
    });
    mount(client, <DirectoryList />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/must NOT have additional properties/)).toBeTruthy();
    expect(screen.getByText(/validation_failed/)).toBeTruthy();
  });
});

/**
 * THE FILTERS ARE THE URL.
 *
 * Every assertion below covers a failure a reader actually hit: a typed search silently discarded
 * by touching a second control, a Back button that landed on an unfiltered first page, and a
 * filtered view that could not be shared or reloaded.
 */
describe("the directory's filters", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
    navigation.push.mockClear();
  });

  it("renders what the URL says, so a shared link and a reload both work", async () => {
    navigation.params = new URLSearchParams("q=zk&type=grant&status=closed&ecosystem=Optimism");
    const { client, list } = stub();
    mount(client, <DirectoryList />);

    await screen.findByText("Acme Foundation");
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      q: "zk",
      fundingType: "grant",
      status: "closed",
      ecosystem: "Optimism",
    });
    // And the controls agree with it, rather than showing a default over a filtered list.
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("zk");
    expect((screen.getByLabelText("Ecosystem") as HTMLInputElement).value).toBe("Optimism");
    expect((screen.getByLabelText("Funding type") as HTMLSelectElement).value).toBe("grant");
  });

  it("CARRIES EVERY LIVE CONTROL ON EVERY APPLY — the silently-discarded-draft bug", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);
    await screen.findByText("Acme Foundation");

    // Type into both free-text boxes, then touch a SELECT — which applies immediately. The old
    // code sent the select's value with the previous selection and dropped both typed values,
    // leaving them on screen looking as though they had been used. Nothing said otherwise.
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zk proofs" } });
    fireEvent.change(screen.getByLabelText("Ecosystem"), { target: { value: "Optimism" } });
    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "grant" } });

    expect(navigation.push).toHaveBeenCalledTimes(1);
    const href = String(navigation.push.mock.calls[0]?.[0]);
    const applied = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(applied.get("q")).toBe("zk proofs");
    expect(applied.get("ecosystem")).toBe("Optimism");
    expect(applied.get("type")).toBe("grant");
  });

  it("returns to page 1 when a filter changes, because page 4 is not page 4 of a new result", async () => {
    navigation.params = new URLSearchParams("page=4");
    const { client } = stub();
    mount(client, <DirectoryList />);
    await screen.findByText("Acme Foundation");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });

    const href = String(navigation.push.mock.calls[0]?.[0]);
    expect(href).not.toContain("page=");
    expect(href).toContain("status=closed");
  });

  it("submits the search form without losing the selects", async () => {
    navigation.params = new URLSearchParams("type=bounty");
    const { client } = stub();
    mount(client, <DirectoryList />);
    await screen.findByText("Acme Foundation");

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "retrieval" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const href = String(navigation.push.mock.calls[0]?.[0]);
    expect(href).toContain("q=retrieval");
    expect(href).toContain("type=bounty");
  });

  it("makes 'include closed and upcoming' a real address rather than a hidden toggle", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);
    await screen.findByText("Acme Foundation");

    // A link, not a button: it can be middle-clicked, bookmarked and sent to somebody, and the
    // back button out of it works for free.
    const toggle = screen.getByRole("link", { name: "Include closed and upcoming" });
    expect(toggle.getAttribute("href")).toBe("/?status=any");
  });

  it("follows the address bar when it changes underneath — the back button", async () => {
    const { client, list } = stub();
    const view = mount(client, <DirectoryList />);
    await screen.findByText("Acme Foundation");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("open");

    // What a Back press looks like from this component's side: new search params, same tree.
    navigation.params = new URLSearchParams("status=closed&q=zk");
    view.rerender(
      <ApiClientProvider value={client}>
        <DirectoryList />
      </ApiClientProvider>,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("closed"),
    );
    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("zk");
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ status: "closed", q: "zk" });
  });
});

describe("the public opportunity page", () => {
  beforeEach(() => {
    authSession.data = null;
    authSession.isPending = false;
    authSession.error = null;
  });

  it("says it is loading before it says anything else", () => {
    const { client } = stub({ find: () => new Promise(() => {}) });
    mount(client, <PublicOpportunity id="acme:round-4" />);

    expect(screen.getByText(/Loading this opportunity/)).toBeTruthy();
  });

  it("reads the public detail route — the one the API counts as a detail view", async () => {
    const { client, find } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    await screen.findByText(HOSTILE_TITLE);
    expect(find).toHaveBeenCalledWith("acme:round-4");
  });

  it("renders the record's public fields", async () => {
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    expect(await screen.findByRole("heading", { name: HOSTILE_TITLE })).toBeTruthy();
    // The identity line: type as a word, status as a badge, the id in mono at the END of it — the
    // reader's questions in the order they ask them, with the join key last.
    expect(screen.getByText("open", { selector: ".badge" }).className).toContain("badge-open");
    expect(screen.getByText("acme:round-4", { selector: "code" })).toBeTruthy();
    expect(screen.getByText(/Grants for public-goods infrastructure/)).toBeTruthy();
    expect(screen.getByText("Teams shipping open-source infrastructure.")).toBeTruthy();

    // The derived "next deadline" AND the full dates table behind it — two renderings of the
    // same instant, which is why this is an all-query rather than a single one.
    expect(screen.getAllByText("30 Sep 23:59 UTC")).toHaveLength(2);
    expect(screen.getByText("application")).toBeTruthy();

    // Money: the per-award range and the committed-to-date figure, in the record's own currency.
    expect(screen.getByText("5,000–50,000 USD per award")).toBeTruthy();
    expect(screen.getByText("120,000 USD")).toBeTruthy();

    // Operating and sponsoring organisations, kept apart. The operator is named twice — in the
    // identity line and under "Runs this opportunity" — and the sponsor only in its own column.
    expect(screen.getAllByText("Acme Foundation")).toHaveLength(2);
    expect(screen.getByText("Beta Collective")).toBeTruthy();

    // The milestone sequence, denominated in the document-wide currency.
    expect(screen.getByText("Testnet launch")).toBeTruthy();
    expect(screen.getByText("25,000 USD")).toBeTruthy();
  });

  it("keeps the public content visible while signed out and offers the claim control", async () => {
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    expect(await screen.findByRole("heading", { name: HOSTILE_TITLE })).toBeTruthy();
    const claim = screen.getByText("This is my programme — claim it");
    expect(claim).toBeTruthy();
    fireEvent.click(claim);
    expect(screen.getByRole("button", { name: "Sign in to claim" })).toBeTruthy();
  });

  it("keeps the public content visible while the session is being restored", async () => {
    authSession.isPending = true;
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    expect(await screen.findByRole("heading", { name: HOSTILE_TITLE })).toBeTruthy();
    fireEvent.click(screen.getByText("This is my programme — claim it"));
    expect(screen.getByText("Restoring your session…")).toBeTruthy();
  });

  it("claims the canonical id returned by the public detail read, not an aliased route id", async () => {
    authSession.data = { user: { id: "user_7" } };
    const me: Me = {
      accountId: 7,
      handle: "acme-programmes",
      displayName: null,
      email: "programmes@acme.example.org",
      role: "submitter",
      directCreate: false,
      credentialKind: "session",
      scopes: [],
      memberships: [
        { slug: "acme", name: "Acme Foundation", role: "publisher", verified: true },
      ],
      canManageKeys: true,
      canReview: false,
      canAdmin: false,
      createdAt: "2026-08-01T00:00:00Z",
    };
    const claim = vi.fn(async () => ({
      outcome: "granted" as const,
      claimId: 19,
      opportunityId: entry.id,
      organizationSlug: "acme",
      message: "Future writes will publish under acme.",
    }));
    const { client: publicClient } = stub();
    const client = {
      ...publicClient,
      me: { get: vi.fn(async () => me) },
      opportunities: { ...publicClient.opportunities, claim },
    } as unknown as ApiClient;

    mount(client, <PublicOpportunity id="legacy:round-4" />);

    fireEvent.click(await screen.findByText("Claim this listing for an organisation"));
    fireEvent.click(screen.getByRole("button", { name: "File the claim" }));
    await waitFor(() =>
      expect(claim).toHaveBeenCalledWith("acme:round-4", {
        organizationSlug: "acme",
        note: null,
      }),
    );
  });

  it("shows the provenance the public payload exposes, including the source check", async () => {
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    await screen.findByText(HOSTILE_TITLE);
    // The verdict is a low-bar anti-spam signal and the badge's own title text says so.
    const badge = screen.getByText("link looks right");
    expect(badge.getAttribute("title")).toMatch(/not a fact-check/);
    expect(screen.getByText(/last checked 10 Aug 09:00 UTC/)).toBeTruthy();
    expect(screen.getByText("publisher_api")).toBeTruthy();
    expect(screen.getByText("R4")).toBeTruthy();
    expect(screen.getByText("1.0.0")).toBeTruthy();
  });

  it("sends the apply action through the API's counted redirect, in a new tab", async () => {
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    // NAMED FOR WHERE IT GOES. The action this page exists for is leaving it, and the label says
    // whose site the reader lands on before they click rather than after.
    const apply = await screen.findByRole("link", { name: /Apply on the programme’s own site/ });
    expect(apply.getAttribute("href")).toBe(`${BASE_URL}/v1/r/acme%3Around-4/apply`);
    expect(apply.getAttribute("target")).toBe("_blank");
    expect(apply.getAttribute("rel")).toBe("noopener noreferrer");
    // It is the one filled control on the page, which is how "this one does the thing" is said
    // without a colour.
    expect(apply.className).toContain("button-primary");

    const source = screen.getByRole("link", { name: "Programme site" });
    expect(source.getAttribute("href")).toBe(`${BASE_URL}/v1/r/acme%3Around-4/source`);
  });

  it("does not dead-end a listing that states no application link", async () => {
    // Roughly one published listing in eight carries no `applicationUrl`. The page used to say so
    // and stop, leaving the reader holding a description and nowhere to go; it now says the same
    // true thing and hands over the programme's own site.
    const { title, ...rest } = entry;
    const noApply: Opportunity = { ...rest, title, applicationUrl: null };
    const { client } = stub({ find: async () => noApply });
    mount(client, <PublicOpportunity id="acme:round-4" />);

    expect(await screen.findByText("This listing states no application link.")).toBeTruthy();
    const fallback = screen.getByRole("link", { name: /Open the programme site/ });
    expect(fallback.getAttribute("href")).toBe(`${BASE_URL}/v1/r/acme%3Around-4/source`);
    expect(fallback.className).toContain("button-primary");
  });

  it("names the raw JSON block for the audience that wants it", async () => {
    const { client } = stub();
    mount(client, <PublicOpportunity id="acme:round-4" />);

    // "Type-specific details (grant)" read like a section of the listing a reader was skipping by
    // mistake. This is a page written for applicants; the one block that is not for them says so.
    expect(await screen.findByText("Machine-readable details (for developers)")).toBeTruthy();
  });

  it("renders a publisher's markup as text, never as markup", async () => {
    const { client } = stub();
    const { container } = mount(client, <PublicOpportunity id="acme:round-4" />);

    await screen.findByText(HOSTILE_TITLE);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img src=x");
  });

  it("surfaces the public, redacted change history", async () => {
    const { client, audit } = stub();
    mount(client, <PublicOpportunity id="legacy:round-4" />);

    await screen.findByText("replace");
    // The route can be an alias. Subresources belong to the canonical id returned by the public
    // detail read, which is also the id shown on the page.
    expect(audit).toHaveBeenCalledWith("acme:round-4");
    expect(screen.getByText("deadlines, fundingInfo")).toBeTruthy();
  });

  it("reports a 404 as the API's own answer rather than an empty page", async () => {
    const { client } = stub({
      find: async () => {
        throw new ApiError(404, "not_found", "opportunity 'acme:nope' not found");
      },
    });
    mount(client, <PublicOpportunity id="acme:nope" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/not found/)).toBeTruthy();
    expect(screen.getByText(/404 · not_found/)).toBeTruthy();
  });
});
