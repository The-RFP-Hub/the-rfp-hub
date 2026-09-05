import { Chrome } from "@/components/Chrome";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me, NotificationList } from "@/lib/types";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigation, session } = vi.hoisted(() => ({
  navigation: { pathname: "/listings" },
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

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

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

const inbox = (unreadCount: number): NotificationList => ({
  items: [],
  page: 1,
  limit: 1,
  total: unreadCount,
  totalPages: Math.max(1, unreadCount),
  unreadCount,
});

function renderChrome(notifications: ApiClient["me"]["notifications"]) {
  const client = {
    baseUrl: "https://api.example.com",
    me: { get: async () => me, notifications },
  } as unknown as ApiClient;
  const tree = (
    <ApiClientProvider value={client}>
      <Chrome>
        <p>Workbench</p>
      </Chrome>
    </ApiClientProvider>
  );
  return { client, tree, view: render(tree) };
}

beforeEach(() => {
  navigation.pathname = "/listings";
  session.data = { user: { id: "u1" } };
  session.isPending = false;
  session.error = null;
});

describe("the notification navigation badge", () => {
  it("shows the unread count and refreshes it on a route change without polling", async () => {
    const notifications = vi.fn(async () => inbox(1)).mockResolvedValueOnce(inbox(3));
    const rendered = renderChrome(notifications);

    expect(
      await screen.findByRole("link", { name: /Notifications 3 unread notifications/ }),
    ).toBeTruthy();
    expect(notifications).toHaveBeenCalledTimes(1);

    navigation.pathname = "/dashboard";
    rendered.view.rerender(
      <ApiClientProvider value={rendered.client}>
        <Chrome>
          <p>Workbench</p>
        </Chrome>
      </ApiClientProvider>,
    );
    expect(
      await screen.findByRole("link", { name: /Notifications 1 unread notification/ }),
    ).toBeTruthy();
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it("caps the printed count at three characters without rounding what it announces", async () => {
    renderChrome(async () => inbox(349));

    const link = await screen.findByRole("link", {
      name: /Notifications 349 unread notifications/,
    });
    expect(link.textContent).toContain("99+");
    expect(link.textContent).not.toContain("349");
  });

  it("keeps the destination available without a badge at zero or when the count read fails", async () => {
    const zero = renderChrome(async () => inbox(0));
    expect(await screen.findByRole("link", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByLabelText(/unread notification/)).toBeNull();
    zero.view.unmount();

    renderChrome(async () => {
      throw new Error("offline");
    });
    expect(await screen.findByRole("link", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByLabelText(/unread notification/)).toBeNull();
  });

  it("does not fetch or render the account destination while signed out", async () => {
    session.data = null;
    const notifications = vi.fn(async () => inbox(4));
    renderChrome(notifications);

    await waitFor(() => expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy());
    expect(notifications).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Notifications/ })).toBeNull();
  });
});
