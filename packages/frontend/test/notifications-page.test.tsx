import NotificationsPage from "@/app/notifications/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me, Notification, NotificationList } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({
  session: { data: { user: { id: "u1" } }, isPending: false, error: null },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session, signOut: vi.fn(), getSession: vi.fn() },
  clearSessionToken: vi.fn(),
  refreshSession: vi.fn(),
  readSessionToken: () => null,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/notifications" }));

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

const suspected: Notification = {
  id: 11,
  kind: "duplicate_suspected",
  subjectKind: "duplicate",
  subjectId: 71,
  payload: {
    pairId: 71,
    similarity: 0.91,
    yourListing: { id: "mine:private", title: "Private submission" },
    action: "review_match",
    link: "/duplicates",
    decidedBy: null,
  },
  createdAt: "2026-08-25T12:00:00Z",
  readAt: null,
};

const merged: Notification = {
  id: 12,
  kind: "duplicate_merged_away",
  subjectKind: "duplicate",
  subjectId: 72,
  payload: {
    pairId: 72,
    similarity: 0.88,
    yourListing: { id: "mine:old", title: "Old listing" },
    otherListing: { id: "public:survivor", title: "Surviving listing" },
    action: "view_survivor",
    link: "/opportunities/public%3Asurvivor",
    decidedBy: "reviewer",
  },
  createdAt: "2026-08-26T12:00:00Z",
  readAt: null,
};

const readNotification = vi.fn<(id: number) => Promise<Notification>>();
const readAllNotifications = vi.fn<() => Promise<{ markedRead: number; unreadCount: number }>>();
let inbox: NotificationList;

function client(): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: async () => me,
      notifications: async ({ page = 1, limit = 20 } = {}) => ({ ...inbox, page, limit }),
      readNotification,
      readAllNotifications,
    },
  } as unknown as ApiClient;
}

beforeEach(() => {
  session.data = { user: { id: "u1" } };
  inbox = {
    items: [merged, suspected].map((item) => ({ ...item })),
    page: 1,
    limit: 20,
    total: 2,
    totalPages: 1,
    unreadCount: 2,
  };
  readNotification.mockReset();
  readNotification.mockImplementation(async (id) => {
    const item = inbox.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("missing notification");
    if (item.readAt === null) {
      item.readAt = "2026-08-26T13:00:00Z";
      inbox.unreadCount--;
    }
    return item;
  });
  readAllNotifications.mockReset();
  readAllNotifications.mockImplementation(async () => {
    const markedRead = inbox.unreadCount;
    inbox.items = inbox.items.map((item) => ({
      ...item,
      readAt: item.readAt ?? "2026-08-26T13:00:00Z",
    }));
    inbox.unreadCount = 0;
    return { markedRead, unreadCount: 0 };
  });
});

describe("the notification inbox", () => {
  it("emphasizes unread rows, uses cautious copy, and links every item to its stored action", async () => {
    render(
      <ApiClientProvider value={client()}>
        <NotificationsPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(await screen.findAllByText("Unread")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Possible match found" })).toBeTruthy();
    expect(screen.getByText(/looked similar to another submission/)).toBeTruthy();
    expect(screen.getByText(/not a verdict/)).toBeTruthy();
    expect(screen.queryByText("Secret counterpart")).toBeNull();

    expect(screen.getByRole("link", { name: "Review possible matches" }).getAttribute("href")).toBe(
      "/duplicates",
    );
    expect(screen.getByRole("link", { name: "Open surviving listing" }).getAttribute("href")).toBe(
      "/opportunities/public%3Asurvivor",
    );
    expect(screen.getByText("Surviving listing")).toBeTruthy();
  });

  it("marks one notification read and refreshes the unread count", async () => {
    render(
      <ApiClientProvider value={client()}>
        <NotificationsPage />
      </ApiClientProvider>,
    );

    const controls = await screen.findAllByRole("button", { name: "Mark as read" });
    fireEvent.click(controls[0] as HTMLButtonElement);

    await waitFor(() => expect(readNotification).toHaveBeenCalledWith(12));
    await waitFor(() => expect(screen.getByText(/1 unread · 2 total/)).toBeTruthy());
    expect(screen.getAllByText("Unread")).toHaveLength(1);
    expect(screen.getAllByText("Read")).toHaveLength(1);
  });

  it("marks the whole inbox read and renders an instructive empty state", async () => {
    const view = render(
      <ApiClientProvider value={client()}>
        <NotificationsPage />
      </ApiClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(readAllNotifications).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("2 notifications marked as read.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull(),
    );

    inbox = { items: [], page: 1, limit: 20, total: 0, totalPages: 1, unreadCount: 0 };
    view.unmount();
    render(
      <ApiClientProvider value={client()}>
        <NotificationsPage />
      </ApiClientProvider>,
    );
    expect(await screen.findByText("No notifications yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Your listings" }).getAttribute("href")).toBe(
      "/listings",
    );
  });
});
