/**
 * `/publishers`. Three things have to be true here and none is visible in an API test: the page
 * reads the unauthenticated route with no token, every publisher-supplied string renders as text
 * rather than markup (hence the hostile fixtures below), and `logoUrl` never becomes an `<img>` —
 * the CSP would block it silently and a broken-image icon would be the only clue.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PublishersPage from "@/app/publishers/page";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Publisher, PublisherList } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/** A name and description nobody would type by accident — exactly what an injection attempt looks like. */
const HOSTILE = '<img src=x onerror="alert(1)">Acme Foundation';

const filecoin: Publisher = {
  slug: "filecoin",
  name: HOSTILE,
  description: "Grants for public-goods infrastructure on Filecoin.",
  website: "https://filecoin.example.org",
  logoUrl: "https://filecoin.example.org/logo.png",
  ecosystems: ["Filecoin", "<script>evil()</script>"],
  verifiedAt: "2026-08-14T00:00:00Z",
};

/** One unbroken token: a name with spaces wraps on its own, so it would prove nothing. */
const UNBROKEN_NAME = "Loooooongestpublishernameimaginable".repeat(30);

const marathon: Publisher = {
  slug: "marathon",
  name: UNBROKEN_NAME,
  description: `${"Unbroken".repeat(120)}.`,
  website: null,
  logoUrl: null,
  ecosystems: [],
  verifiedAt: null,
};

const beta: Publisher = {
  slug: "beta",
  name: "Beta Collective",
  description: null,
  website: "javascript:alert(1)",
  logoUrl: null,
  ecosystems: [],
  verifiedAt: null,
};

function client(overrides?: { list?: () => Promise<PublisherList> }): {
  client: ApiClient;
  list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(
    overrides?.list ?? (async () => ({ items: [filecoin, beta], total: 2 }) as PublisherList),
  );
  return {
    client: { baseUrl: "https://api.example.com", publishers: { list } } as unknown as ApiClient,
    list,
  };
}

const mount = (apiClient: ApiClient) =>
  render(
    <ApiClientProvider value={apiClient}>
      <PublishersPage />
    </ApiClientProvider>,
  );

describe("the public publishers page", () => {
  it("says it is loading before it says anything else", () => {
    const { client: c } = client({ list: () => new Promise(() => {}) });
    mount(c);

    expect(screen.getByText(/Loading the verified publishers/)).toBeTruthy();
  });

  it("reads the public, unauthenticated publishers route", async () => {
    const { client: c, list } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith();
  });

  it("renders a publisher's name and description as TEXT, not markup", async () => {
    const { client: c } = client();
    mount(c);

    // The hostile string appears verbatim as a text node; an injected <img> would not.
    expect(await screen.findByText(HOSTILE)).toBeTruthy();
    expect(screen.getByText("Grants for public-goods infrastructure on Filecoin.")).toBeTruthy();
    expect(screen.getByText("<script>evil()</script>")).toBeTruthy();

    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("never renders logoUrl as an <img>", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("linked, not embedded").closest("a")?.getAttribute("href")).toBe(
      filecoin.logoUrl,
    );
  });

  it("links the http(s) website, and shows the unsafe one as inert text", async () => {
    const { client: c } = client();
    mount(c);

    const filecoinLink = await screen.findByRole("link", { name: filecoin.website ?? "" });
    expect(filecoinLink.getAttribute("href")).toBe(filecoin.website);
    expect(filecoinLink.getAttribute("rel")).toBe("noopener noreferrer");

    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull();
  });

  it("shows an honest fallback for a publisher with no description", async () => {
    const { client: c } = client();
    mount(c);

    expect(await screen.findByText("This publisher has not written a description.")).toBeTruthy();
  });

  it("links each card to the directory filtered by that organization", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    const links = screen.getAllByRole("link", { name: "View this publisher’s listings" });
    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/?organization=filecoin");
    expect(hrefs).toContain("/?organization=beta");
  });

  it("says on the page what that filtered directory link will match", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    expect(
      screen.getAllByText("Every listing this organization operates or sponsors."),
    ).toHaveLength(2);
  });

  it("labels the namespace for a reader who cannot see it is a namespace", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    const labels = screen.getAllByText("Namespace:");
    expect(labels).toHaveLength(2);
    expect(labels[0]?.className).toContain("visually-hidden");
    expect(labels[0]?.parentElement?.querySelector("code")?.textContent).toBe("filecoin:…");
  });

  it("names the publisher in the logo link, which every card otherwise labels identically", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    const logo = screen.getByRole("link", { name: `${HOSTILE} logo (external link)` });
    expect(logo.getAttribute("href")).toBe(filecoin.logoUrl);
  });

  it("wraps an unbroken publisher name rather than widening the card", async () => {
    const { client: c } = client({ list: async () => ({ items: [marathon], total: 1 }) });
    mount(c);

    expect(await screen.findByText(UNBROKEN_NAME)).toBeTruthy();

    // jsdom lays nothing out, so what protects a 375px viewport is the rule itself.
    const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const wrapping = css
      .split("}")
      .map((block) => block.split("{"))
      .filter(([, body]) => body?.includes("overflow-wrap: anywhere"))
      .flatMap(([selector]) => (selector ?? "").split(",").map((one) => one.trim()));
    expect(wrapping).toContain(".publisher-card h2");
    expect(wrapping).toContain(".publisher-description");
  });

  it("stamps a stable, checkable slug on each card's root element", async () => {
    const { client: c } = client();
    mount(c);

    await screen.findByText(HOSTILE);
    const cards = document.querySelectorAll('[data-testid="publisher-card"]');
    const slugs = [...cards].map((card) => card.getAttribute("data-publisher-slug"));
    expect(slugs.sort()).toEqual(["beta", "filecoin"]);
  });

  it("shows an honest empty state, linking to how a publisher gets verified", async () => {
    const { client: c } = client({ list: async () => ({ items: [], total: 0 }) });
    mount(c);

    expect(await screen.findByText("No organization is verified yet.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "How to become a verified publisher" });
    expect(link.getAttribute("href")).toMatch(/PUBLISHERS\.md$/);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows an honest error state and offers to retry", async () => {
    const failing = vi.fn(async () => {
      throw new ApiError(0, "network_error", "The network request failed.");
    });
    const c = {
      baseUrl: "https://api.example.com",
      publishers: { list: failing },
    } as unknown as ApiClient;
    mount(c);

    expect(await screen.findByText(/We couldn.t load the verified publishers/)).toBeTruthy();
  });
});
