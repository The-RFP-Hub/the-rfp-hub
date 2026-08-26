/**
 * THE RENDER TEST THE MILESTONE ASKS FOR.
 *
 * An API integration test proves the numbers can be computed. A traffic-generating script proves
 * events can be captured. Neither proves the thing a publisher is promised: that opening the
 * dashboard shows them. This does — it mounts the real Analytics tab against a fixture
 * `InsightsSeries` of exactly the shape `GET /v1/insights/opportunities/{id}` returns, and asserts
 * that the totals, the bars and the day labels are on the page.
 *
 * The API client is INJECTED through the same context the application uses, so nothing is stubbed
 * out inside the component under test: the component fetches, awaits and renders exactly as it does
 * in a browser. No network, no auth SDK, no database.
 */
import DashboardPage from "@/app/dashboard/page";
import { AnalyticsTab } from "@/components/AnalyticsTab";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { InsightsSeries, InsightsSummary, Me } from "@/lib/types";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({
  session: {
    data: { user: { id: "u1" } } as { user: { id: string } } | null,
    isPending: false,
    error: null,
  },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut: vi.fn(), getSession: vi.fn() },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

/** Zero-filled for the whole window, exactly as the API returns it — including the empty days. */
const series: InsightsSeries = {
  opportunityId: "acme:round-1",
  title: "Acme Ecosystem Round One",
  from: "2026-08-08",
  to: "2026-08-14",
  totals: { listViews: 128, detailViews: 42, sourceClicks: 9, applyClicks: 7 },
  days: [
    { day: "2026-08-08", listViews: 10, detailViews: 3, sourceClicks: 1, applyClicks: 0 },
    { day: "2026-08-09", listViews: 0, detailViews: 0, sourceClicks: 0, applyClicks: 0 },
    { day: "2026-08-10", listViews: 22, detailViews: 6, sourceClicks: 2, applyClicks: 1 },
    { day: "2026-08-11", listViews: 31, detailViews: 9, sourceClicks: 1, applyClicks: 2 },
    { day: "2026-08-12", listViews: 18, detailViews: 5, sourceClicks: 0, applyClicks: 0 },
    { day: "2026-08-13", listViews: 24, detailViews: 12, sourceClicks: 3, applyClicks: 3 },
    { day: "2026-08-14", listViews: 23, detailViews: 7, sourceClicks: 2, applyClicks: 1 },
  ],
};

function clientReturning(data: InsightsSeries | Promise<never>): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    insights: { forOpportunity: vi.fn(async () => data) },
  } as unknown as ApiClient;
}

function renderTab(client: ApiClient) {
  return render(
    <ApiClientProvider value={client}>
      <AnalyticsTab opportunityId="acme:round-1" />
    </ApiClientProvider>,
  );
}

describe("the analytics tab", () => {
  it("renders the totals, one bar per day and the day labels from a real series shape", async () => {
    const { container } = renderTab(clientReturning(series));

    // Totals, as the four separate counters the API keeps apart. Queried as the tiles they are —
    // the bare numbers also appear in the day-by-day table, which is the point of having both.
    expect(await screen.findByRole("button", { name: "128 List views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "42 Detail views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "9 Source clicks" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 Apply clicks" })).toBeTruthy();

    // One bar per day in the window, including the zero day — a gap-free series draws a gap-free
    // chart, which is the reason the API zero-fills it.
    const bars = container.querySelectorAll("rect.bar");
    expect(bars.length).toBe(series.days.length);
    expect(container.querySelectorAll("rect.bar-zero").length).toBe(1);

    // Each bar names its day and value, so the chart is readable without seeing it. Queried
    // directly rather than through `getByTitle`, which only reaches an SVG `<title>` that is a
    // child of the `<svg>` itself — a per-bar title is a child of the `<rect>`.
    const barTitles = Array.from(container.querySelectorAll("rect.bar > title")).map(
      (title) => title.textContent,
    );
    expect(barTitles).toContain("13 Aug: 12");
    expect(barTitles).toContain("9 Aug: 0");
    expect(barTitles).toHaveLength(series.days.length);

    // The axis is labelled with the real first and last day of the window.
    expect(screen.getAllByText("8 Aug").length).toBeGreaterThan(0);
    expect(screen.getAllByText("14 Aug").length).toBeGreaterThan(0);

    // The title of the entry, and the promise the whole surface has to keep.
    expect(screen.getByText(/Acme Ecosystem Round One/)).toBeTruthy();
    expect(screen.getByText(/Best-effort/)).toBeTruthy();
    expect(container.querySelectorAll("details th.numeric")).toHaveLength(series.days.length + 2);
    expect(container.querySelectorAll("details td.numeric")).toHaveLength(series.days.length);
  });

  it("draws the flat floor rather than dividing by zero when nothing has happened yet", async () => {
    const empty: InsightsSeries = {
      ...series,
      totals: { listViews: 0, detailViews: 0, sourceClicks: 0, applyClicks: 0 },
      days: series.days.map((day) => ({
        ...day,
        listViews: 0,
        detailViews: 0,
        sourceClicks: 0,
        applyClicks: 0,
      })),
    };
    const { container } = renderTab(clientReturning(empty));

    await screen.findByText("No detail views in this window");
    expect(container.querySelectorAll("rect.bar-zero").length).toBe(empty.days.length);
  });

  it("shows the API's own failure rather than an empty chart", async () => {
    const failing = {
      baseUrl: "https://api.example.com",
      insights: {
        forOpportunity: vi.fn(async () => {
          const { ApiError } = await import("@/lib/api");
          throw new ApiError(403, "forbidden", "This entry is not yours.");
        }),
      },
    } as unknown as ApiClient;

    renderTab(failing);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/This entry is not yours\./)).toBeTruthy();
    expect(screen.getByText(/forbidden/)).toBeTruthy();
  });
});

describe("the dashboard", () => {
  it("keeps submission in the header when published analytics already exist", async () => {
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
    const summary: InsightsSummary = {
      from: "2026-07-26",
      to: "2026-08-25",
      totals: { listViews: 20, detailViews: 8, sourceClicks: 3, applyClicks: 2 },
      opportunities: [
        {
          opportunityId: "acme:round-1",
          title: "Acme Round One",
          listViews: 20,
          detailViews: 8,
          sourceClicks: 3,
          applyClicks: 2,
        },
      ],
    };
    const client = {
      baseUrl: "https://api.example.com",
      me: { get: async () => me },
      insights: { summary: vi.fn(async () => summary) },
    } as unknown as ApiClient;

    const { container } = render(
      <ApiClientProvider value={client}>
        <DashboardPage />
      </ApiClientProvider>,
    );

    const link = await screen.findByRole("link", { name: "Submit an opportunity" });
    expect(link.getAttribute("href")).toBe("/listings/new");
    expect(await screen.findByText("Acme Round One")).toBeTruthy();
    expect(container.querySelector("ul.kpi-grid")).toBeTruthy();
    expect(container.querySelectorAll(".kpi-grid .tile-value")).toHaveLength(4);
    expect(container.querySelectorAll("table th.numeric")).toHaveLength(2);
    expect(container.querySelectorAll("table td.numeric")).toHaveLength(2);
  });

  it("makes login primary when the dashboard is signed out", () => {
    session.data = null;
    const client = { baseUrl: "https://api.example.com" } as unknown as ApiClient;

    render(
      <ApiClientProvider value={client}>
        <DashboardPage />
      </ApiClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Log in" }).className).toContain("button-primary");
  });
});
