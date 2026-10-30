/**
 * `/leaving/[id]`: the page the API's link-out redirect will send a reader to instead of a link it
 * will not follow silently.
 *
 * THE PROPERTY EVERY TEST BELOW DEFENDS is that the destination comes from the LISTING and never
 * from the address bar. The query may say which of the two stored links and why; anything else in
 * it — including a URL in either of those two parameters — must leave no trace on the page, and
 * "Continue" must point at exactly the stored value or not be offered at all.
 *
 * Rendered through the route's own page component, with `useParams`/`useSearchParams` stubbed and
 * the API client injected through the same context the application uses. No network.
 */
import LeavingPage from "@/app/leaving/[id]/page";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { CLOSED_NOTICE, SECURITY_NOTICE, readLeavingQuery } from "@/lib/leaving";
import type { Opportunity } from "@/lib/types";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { route } = vi.hoisted(() => ({
  route: { id: "acme%3Around-4", query: "" },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false, error: null }) },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: route.id }),
  useSearchParams: () => new URLSearchParams(route.query),
  usePathname: () => `/leaving/${route.id}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const APPLY_URL = "https://www.typeform.com/to/AbC123?round=4";
const SITE_URL = "https://acme.example.org/grants";
const HOSTILE_TITLE = '<img src=x onerror="alert(1)">Retro Funding Round Four';

const entry: Opportunity = {
  specVersion: "1.0.0",
  id: "acme:round-4",
  fundingType: "grant",
  title: HOSTILE_TITLE,
  description: "Grants for public-goods infrastructure.",
  status: "open",
  operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
  source: {},
  deadlines: [],
  fundingDetails: { fundingType: "grant" },
  applicationUrl: APPLY_URL,
  website: SITE_URL,
} as Opportunity;

function client(find: (id: string) => Promise<Opportunity> = async () => entry) {
  const spy = vi.fn(find);
  return {
    api: { baseUrl: "https://api.example.com", directory: { find: spy } } as unknown as ApiClient,
    find: spy,
  };
}

function open(query: string, api: ApiClient = client().api) {
  route.query = query;
  return render(
    <ApiClientProvider value={api}>
      <LeavingPage />
    </ApiClientProvider>,
  );
}

const continueLink = () => screen.findByRole("link", { name: /^Continue to / });

beforeEach(() => {
  route.id = "acme%3Around-4";
  route.query = "";
});

describe("the leaving page, offering the stored link", () => {
  it("reads the public listing by the id in its path, and nothing else", async () => {
    const { api, find } = client();
    open("link=apply&reason=unreviewed", api);

    await continueLink();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith("acme:round-4");
  });

  it("says where the link goes: the host prominently, the full URL as text, the listing linked", async () => {
    open("link=apply&reason=unreviewed");

    expect(
      await screen.findByRole("heading", { level: 1, name: "You’re leaving RFPSear.ch" }),
    ).toBeTruthy();
    // The host without its `www.`, as the large line under "Where it goes".
    const host = await screen.findByText("www.typeform.com", { selector: ".leaving-host *" });
    expect(host).toBeTruthy();
    // The whole URL, verbatim, and as text rather than as a second link.
    const full = screen.getByText(APPLY_URL);
    expect(full.closest("a")).toBeNull();
    expect(full.closest("dd")?.className).toContain("leaving-url");

    const back = screen.getAllByRole("link", { name: HOSTILE_TITLE });
    expect(back[0]?.getAttribute("href")).toBe("/opportunities/acme%3Around-4");
  });

  it("points Continue at exactly the stored applicationUrl, same tab, with no referrer and no follow", async () => {
    open("link=apply&reason=unreviewed");

    const go = await continueLink();
    expect(go.textContent).toBe("Continue to www.typeform.com");
    expect(go.getAttribute("href")).toBe(APPLY_URL);
    expect(go.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(go.getAttribute("target")).toBeNull();
    expect(go.className).toContain("button-primary");
  });

  it("offers the way back to the listing beside it", async () => {
    open("link=apply&reason=closed");

    await continueLink();
    const back = screen.getByRole("link", { name: "Back to the listing" });
    expect(back.getAttribute("href")).toBe("/opportunities/acme%3Around-4");
  });

  it("uses the stored website for link=source", async () => {
    open("link=source&reason=unreviewed");

    const go = await continueLink();
    expect(go.getAttribute("href")).toBe(SITE_URL);
    expect(go.textContent).toBe("Continue to acme.example.org");
    expect(screen.getByText(/The link to the program’s site on/)).toBeTruthy();
    expect(screen.queryByText(APPLY_URL)).toBeNull();
  });

  it.each([
    ["missing", "reason=unreviewed"],
    ["unknown", "link=bogus&reason=unreviewed"],
    ["differently cased", "link=SOURCE&reason=unreviewed"],
    ["empty", "link=&reason=unreviewed"],
  ])("falls back to the application link when link is %s", async (_, query) => {
    open(query);

    const go = await continueLink();
    expect(go.getAttribute("href")).toBe(APPLY_URL);
    expect(screen.getByText(/The application link on/)).toBeTruthy();
  });

  it("resolves an alias to the canonical listing for the way back", async () => {
    route.id = "legacy%3Aold-round";
    open("link=apply&reason=closed");

    await continueLink();
    expect(screen.getByRole("link", { name: "Back to the listing" }).getAttribute("href")).toBe(
      "/opportunities/acme%3Around-4",
    );
  });

  it("follows a stored loopback http:// link, the API's own exemption for local stacks", async () => {
    const local = { ...entry, applicationUrl: "http://localhost:3001/apply" };
    open("link=apply&reason=unreviewed", client(async () => local).api);

    const go = await continueLink();
    expect(go.getAttribute("href")).toBe("http://localhost:3001/apply");
    expect(go.textContent).toBe("Continue to localhost:3001");
  });

  it("names the host the browser will connect to, not the one a URL's text leads with", async () => {
    const tricky = { ...entry, applicationUrl: "https://airtable.com@evil.example/form" };
    open("link=apply&reason=unreviewed", client(async () => tricky).api);

    const go = await continueLink();
    expect(go.textContent).toBe("Continue to evil.example");
    expect(screen.getByText("evil.example", { selector: ".leaving-host *" })).toBeTruthy();
  });
});

describe("what the security notice says", () => {
  const notice = async () => {
    await continueLink();
    return screen.getByText("Security notice").closest(".leaving-reason") as HTMLElement;
  };

  it.each([
    ["closed", "link=apply&reason=closed"],
    ["landing_changed", "link=apply&reason=landing_changed"],
    ["unreviewed", "link=apply&reason=unreviewed"],
    ["missing", "link=apply"],
    ["unknown", "link=apply&reason=compromised"],
  ])("states no fact the listing does not back when the reason is %s", async (_, query) => {
    // An OPEN listing: whatever the query claims, the page only shows the plain notice.
    open(query);

    expect(within(await notice()).getByText(SECURITY_NOTICE)).toBeTruthy();
    expect(screen.queryByText(CLOSED_NOTICE)).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /is closed|different site|review|checked it|vouch/i,
    );
    // Still one click from the destination: a caution, never a stop.
    expect((await continueLink()).getAttribute("href")).toBe(APPLY_URL);
  });

  it.each([
    ["closed", "link=apply&reason=closed"],
    ["archived", "link=apply&reason=unreviewed"],
    ["closed", "link=apply"],
  ] as const)(
    "says the program is closed when the listing itself is %s (%s)",
    async (status, query) => {
      open(query, client(async () => ({ ...entry, status })).api);

      expect(within(await notice()).getByText(CLOSED_NOTICE)).toBeTruthy();
      expect(screen.queryByText(SECURITY_NOTICE)).toBeNull();
      expect((await continueLink()).getAttribute("href")).toBe(APPLY_URL);
    },
  );
});

describe("a query carrying a destination of its own", () => {
  const EVIL = "https://evil.example/phish";

  it.each([
    `link=${encodeURIComponent(EVIL)}&reason=unreviewed`,
    `link=apply&reason=${encodeURIComponent(EVIL)}`,
    `link=apply&reason=unreviewed&url=${encodeURIComponent(EVIL)}&to=${encodeURIComponent(EVIL)}&destination=${encodeURIComponent(EVIL)}`,
    `link=apply&link=${encodeURIComponent(EVIL)}&reason=closed&next=${encodeURIComponent(EVIL)}`,
  ])("is ignored: %s", async (query) => {
    const { container } = open(query);

    const go = await continueLink();
    expect(go.getAttribute("href")).toBe(APPLY_URL);
    expect(container.innerHTML).not.toContain("evil.example");
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).not.toContain("evil.example");
    }
  });

  it("is ignored even when the listing has no link to offer", async () => {
    const none = { ...entry, applicationUrl: null };
    const { container } = open(
      `link=apply&url=${encodeURIComponent(EVIL)}`,
      client(async () => none).api,
    );

    expect(await screen.findByRole("heading", { name: "This link isn’t available" })).toBeTruthy();
    expect(container.innerHTML).not.toContain("evil.example");
  });

  it("reads only the two parameters it knows, exactly as the API writes them", () => {
    expect(readLeavingQuery(new URLSearchParams(`link=${EVIL}&reason=${EVIL}`))).toEqual({
      link: "apply",
      reason: null,
    });
    expect(readLeavingQuery(new URLSearchParams("link=source&reason=landing_changed"))).toEqual({
      link: "source",
      reason: "landing_changed",
    });
  });
});

describe("refusing to offer Continue", () => {
  async function expectUnavailable() {
    expect(await screen.findByRole("heading", { name: "This link isn’t available" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Continue/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "You’re leaving RFPSear.ch" })).toBeNull();
    const back = screen.getByRole("link", { name: "Back to the listing" });
    return back;
  }

  it("when the listing is not published", async () => {
    const { api } = client(async () => {
      throw new ApiError(404, "not_found", "opportunity 'acme:round-4' not found");
    });
    open("link=apply&reason=unreviewed", api);

    const back = await expectUnavailable();
    expect(back.getAttribute("href")).toBe("/opportunities/acme%3Around-4");
    expect(screen.getByText(/no published listing at this address/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Search the directory" })).toBeTruthy();
  });

  it("when the listing has been merged away", async () => {
    const { api } = client(async () => {
      throw new ApiError(409, "opportunity_merged", "merged", {
        mergedInto: { id: "acme:current", title: "Current" },
      });
    });
    open("link=apply&reason=unreviewed", api);

    await expectUnavailable();
  });

  it.each([
    ["no applicationUrl", "link=apply", { applicationUrl: null }],
    ["an empty applicationUrl", "link=apply", { applicationUrl: "" }],
    ["no website", "link=source", { website: undefined }],
  ])("when the listing carries %s", async (_, query, patch) => {
    open(`${query}&reason=unreviewed`, client(async () => ({ ...entry, ...patch })).api);

    const back = await expectUnavailable();
    expect(back.getAttribute("href")).toBe("/opportunities/acme%3Around-4");
    // The listing itself is named and linked: the reader knows which one this was about.
    expect(screen.getAllByRole("link", { name: HOSTILE_TITLE })[0]?.getAttribute("href")).toBe(
      "/opportunities/acme%3Around-4",
    );
  });

  it.each([
    "http://acme.example.org/apply",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "https:acme.example.org/apply",
    "//acme.example.org/apply",
    "ftp://acme.example.org/apply",
  ])("when the stored value is %s, and without printing it", async (stored) => {
    const { container } = open(
      "link=apply&reason=unreviewed",
      client(async () => ({ ...entry, applicationUrl: stored })).api,
    );

    await expectUnavailable();
    expect(container.textContent).not.toContain(stored);
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).not.toBe(stored);
    }
  });

  it("does not report an API outage as an answer about the link", async () => {
    const { api } = client(async () => {
      throw new ApiError(503, "unavailable", "database unavailable");
    });
    open("link=apply&reason=unreviewed", api);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/We couldn’t load where this link goes/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Continue/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the listing" }).getAttribute("href")).toBe(
      "/opportunities/acme%3Around-4",
    );
  });

  it("tries again from the failure state, and offers Continue once the listing loads", async () => {
    let calls = 0;
    const { api } = client(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(503, "unavailable", "database unavailable");
      return entry;
    });
    open("link=apply&reason=unreviewed", api);

    (await screen.findByRole("button", { name: "Try again" })).click();
    expect((await continueLink()).getAttribute("href")).toBe(APPLY_URL);
  });

  it("treats a malformed id escape as an id, not as a crash", async () => {
    route.id = "acme%3Around-4%E0%A4%A";
    const { api, find } = client(async () => {
      throw new ApiError(404, "not_found", "not found");
    });
    open("link=apply", api);

    await expectUnavailable();
    expect(find).toHaveBeenCalledWith("acme%3Around-4%E0%A4%A");
  });
});

describe("what the page renders", () => {
  it("says it is loading before it says anything else, under the same heading", () => {
    open("link=apply", client(() => new Promise(() => {})).api);

    expect(screen.getByRole("heading", { name: "You’re leaving RFPSear.ch" })).toBeTruthy();
    expect(screen.getByText(/Loading where this link goes/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Continue/ })).toBeNull();
  });

  it("renders publisher strings as text and loads nothing from the destination", async () => {
    const hostile = {
      ...entry,
      applicationUrl: "https://forms.example.org/a?x=<script>alert(1)</script>",
    };
    const { container } = open("link=apply&reason=unreviewed", client(async () => hostile).api);

    await continueLink();
    expect(container.innerHTML).toContain("&lt;img src=x");
    expect(container.innerHTML).toContain("&lt;script&gt;");
    // Plain anchors and text: nothing that would need the CSP loosened or tell the destination
    // about a reader who decided not to go.
    for (const tag of ["img", "script", "iframe", "link", "object", "embed", "form"]) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
  });
});
