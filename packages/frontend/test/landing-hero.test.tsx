/**
 * THE FRONT PAGE HERO, rendered from a stubbed open set: the production copy, the search and pills
 * opening the directory, the hand of three real listings, and the four figures. One read of the list
 * route and one of the verified publishers, and never the detail route that counts a view.
 */
import { Landing } from "@/components/Landing";
import type { ApiClient } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { OpportunitySummary, PaginatedOpportunities, Publisher } from "@/lib/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigation } = vi.hoisted(() => ({ navigation: { push: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

function listing(patch: Partial<OpportunitySummary> & { id: string }): OpportunitySummary {
  return {
    specVersion: "1.0.0",
    fundingType: "grant",
    title: patch.id,
    status: "open",
    operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
    source: {},
    deadlines: [],
    ...patch,
  } as OpportunitySummary;
}

const ITEMS = [
  listing({
    id: "acme:grants",
    title: "Public goods grants",
    fundingInfo: { currency: "USD", maxAward: 50_000 },
    deadlines: [{ deadlineType: "rolling" }],
  }),
  listing({
    id: "goa:hack",
    title: "Hacker House Goa",
    fundingType: "hackathon",
    operatingOrganizations: [
      { name: "Goa DAO", slug: "goa" },
      { name: "Beta Labs", slug: "beta" },
    ],
    fundingInfo: { currency: "USD", budget: 85_000 },
  }),
  listing({
    id: "bug:bounty",
    title: "Bug bounty",
    fundingType: "bounty",
    fundingInfo: { currency: "USD", maxAward: 16_000_000 },
  }),
  listing({ id: "x:rfp", title: "An RFP", fundingType: "rfp" }),
];

function publisher(slug: string): Publisher {
  return {
    slug,
    name: slug,
    description: null,
    website: null,
    logoUrl: null,
    ecosystems: [],
    verifiedAt: "2026-10-01T00:00:00Z",
  };
}

/** `verified` is what `GET /v1/publishers` answers: a list of slugs, or a failed read. */
function mount(items: OpportunitySummary[] = ITEMS, verified: string[] | ApiError = []) {
  const page: PaginatedOpportunities = {
    items,
    page: 1,
    limit: 100,
    total: items.length,
    totalPages: 1,
  };
  const list = vi.fn(async () => page);
  const find = vi.fn();
  const publishers = vi.fn(async () => {
    if (verified instanceof ApiError) throw verified;
    return { items: verified.map(publisher), total: verified.length };
  });
  const client = {
    baseUrl: "https://api.example.com",
    directory: { list, find },
    publishers: { list: publishers },
  };
  render(
    <ApiClientProvider value={client as unknown as ApiClient}>
      <Landing />
    </ApiClientProvider>,
  );
  return { list, find, publishers };
}

const cardLinks = async () =>
  within(await screen.findByRole("list", { name: "One open grant, hackathon and bounty" }))
    .getAllByRole("link")
    .map((card) => card.getAttribute("href"));

describe("the landing hero", () => {
  beforeEach(() => navigation.push.mockReset());

  it("keeps the production copy, one h1, and the four figures", async () => {
    const { list, find, publishers } = mount();
    const hero = screen.getByRole("region", { name: "Find funding across the Ethereum ecosystem" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      within(hero).getByText(
        "Open grants, hackathons, bounties and RFPs from organizations supporting Ethereum.",
      ),
    ).toBeTruthy();
    const tally = document.querySelector('dl[aria-label="The index at a glance"]') as HTMLElement;
    for (const unit of [
      "Open opportunities",
      "In max awards",
      "Organizations",
      "Closing in 30 days",
    ]) {
      expect(within(tally).getByText(unit)).toBeTruthy();
    }
    expect(await within(tally).findByText("4")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    expect(publishers).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
  });

  it("searches and picks a type in the directory, as before", async () => {
    mount();
    const field = screen.getByRole("searchbox", { name: "Search the directory" });
    expect(field.getAttribute("placeholder")).toBe("Search by topic, org or city…");
    fireEvent.change(field, { target: { value: " zk " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(navigation.push).toHaveBeenLastCalledWith("/directory?q=zk");
    fireEvent.click(await screen.findByRole("button", { name: /^Grants/ }));
    expect(navigation.push).toHaveBeenLastCalledWith("/directory?type=grant");
  });

  it("deals one grant, hackathon and bounty, each card opening its own listing", async () => {
    mount();
    const hand = await screen.findByRole("list", { name: "One open grant, hackathon and bounty" });
    const cards = within(hand).getAllByRole("link");
    expect(cards.map((card) => card.getAttribute("href"))).toEqual([
      "/opportunities/acme%3Agrants",
      "/opportunities/goa%3Ahack",
      "/opportunities/bug%3Abounty",
    ]);
    expect(within(cards[0] as HTMLElement).getByText("Rolling")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Goa DAO and Beta Labs")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("$85k")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("pool", { exact: false })).toBeTruthy();
    expect(within(cards[2] as HTMLElement).getByText("$16M")).toBeTruthy();
    expect((cards[2] as HTMLElement).style.getPropertyValue("--award-scale")).toBe("1");
    // On a phone the card worth the most leads the row.
    const slots = within(hand).getAllByRole("listitem");
    expect(slots.map((slot) => slot.hasAttribute("data-lead"))).toEqual([false, false, true]);
  });

  it("leaves the hand out when the open set has none of its types", async () => {
    mount([listing({ id: "x:rfp", title: "An RFP", fundingType: "rfp" })]);
    expect(await screen.findByText("Closing in 30 days")).toBeTruthy();
    await screen.findByRole("button", { name: /^RFPs/ });
    expect(screen.queryByRole("list", { name: /One open grant/ })).toBeNull();
    expect(screen.queryByText("Loading listings…")).toBeNull();
  });
  describe("verified organizations first", () => {
    const WITH_VERIFIED = [
      ...ITEMS,
      listing({
        id: "ef:bounty",
        title: "Verified bounty",
        fundingType: "bounty",
        operatingOrganizations: [{ name: "Verified Foundation", slug: "verified" }],
        fundingInfo: { currency: "USD", maxAward: 1_000_000 },
      }),
    ];

    it("deals a verified organization's listing ahead of a larger unverified one", async () => {
      mount(WITH_VERIFIED, ["verified"]);
      expect(await cardLinks()).toEqual([
        "/opportunities/acme%3Agrants",
        "/opportunities/goa%3Ahack",
        "/opportunities/ef%3Abounty",
      ]);
    });

    it("deals by award size when no organization in the set is verified", async () => {
      mount(WITH_VERIFIED, ["someone-else"]);
      expect((await cardLinks())[2]).toBe("/opportunities/bug%3Abounty");
    });

    it("deals by award size, and still shows the page, when the publishers read fails", async () => {
      mount(WITH_VERIFIED, new ApiError(503, "unavailable", "Down"));
      expect((await cardLinks())[2]).toBe("/opportunities/bug%3Abounty");
      const tally = document.querySelector('dl[aria-label="The index at a glance"]') as HTMLElement;
      expect(await within(tally).findByText("5")).toBeTruthy();
      expect(screen.getByText(/See all 5 open opportunities/)).toBeTruthy();
    });
  });
});
