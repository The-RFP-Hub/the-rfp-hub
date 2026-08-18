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
import type { AuditTrail, Opportunity, PaginatedOpportunities } from "@/lib/types";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
      status: undefined,
      ecosystem: undefined,
      sort: "nextDeadlineAt",
      order: "asc",
      page: 1,
      limit: 20,
    });
  });

  it("renders the fields the thin list projection actually carries", async () => {
    const { client } = stub();
    mount(client, <DirectoryList />);

    // Title, and the identity line under it.
    expect(await screen.findByText(HOSTILE_TITLE)).toBeTruthy();
    expect(screen.getByText("acme:round-4")).toBeTruthy();
    expect(screen.getByText(/grant · open/)).toBeTruthy();

    // The operating organisation — entry 0, the party that runs the intake.
    expect(screen.getByText("Acme Foundation")).toBeTruthy();
    expect(screen.getByText("Optimism, Base")).toBeTruthy();

    // The next FIXED deadline, derived from the array, not the last entry in it.
    expect(screen.getByText("30 Sep 23:59 UTC")).toBeTruthy();
    // A rolling-only record says so rather than showing a blank.
    expect(screen.getByText("Rolling")).toBeTruthy();

    // The funding envelope as the number an applicant decides on.
    expect(screen.getByText("5,000–50,000 USD per award")).toBeTruthy();

    // The count and the page, from the envelope.
    expect(screen.getByText(/2 published opportunities · page 1 of 1/)).toBeTruthy();
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
    const { client } = stub({ list: async () => empty });
    mount(client, <DirectoryList />);

    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
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

describe("the public opportunity page", () => {
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
    expect(screen.getByText(/grant · open/)).toBeTruthy();
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

    const apply = await screen.findByRole("link", { name: "Open the application page" });
    expect(apply.getAttribute("href")).toBe(`${BASE_URL}/v1/r/acme%3Around-4/apply`);
    expect(apply.getAttribute("target")).toBe("_blank");
    expect(apply.getAttribute("rel")).toBe("noopener noreferrer");

    const source = screen.getByRole("link", { name: "Open the programme site" });
    expect(source.getAttribute("href")).toBe(`${BASE_URL}/v1/r/acme%3Around-4/source`);
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
    mount(client, <PublicOpportunity id="acme:round-4" />);

    await screen.findByText("replace");
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
