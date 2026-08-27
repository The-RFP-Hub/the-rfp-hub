import DuplicatesPage from "@/app/duplicates/page";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { Me, OwnedDuplicateList } from "@/lib/types";
import { render, screen } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/duplicates",
}));

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

const matches: OwnedDuplicateList = {
  items: [
    {
      id: "public:round one",
      title: "Public Round",
      isPublic: true,
      similarity: 0.91,
      matchedOn: ["lexical"],
      status: "suspected",
      detectedAt: "2026-08-20T12:00:00Z",
      yourListing: { id: "mine:first round", title: "My First Round" },
    },
    {
      id: "private:round two",
      title: "Private Round",
      isPublic: false,
      similarity: 0.87,
      matchedOn: ["lexical"],
      status: "confirmed",
      detectedAt: "2026-08-21T12:00:00Z",
      yourListing: { id: "mine:second round", title: "My Second Round" },
    },
  ],
};

function client(): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: {
      get: async () => me,
      duplicates: async () => matches,
    },
  } as unknown as ApiClient;
}

beforeEach(() => {
  session.data = { user: { id: "u1" } };
});

describe("the account duplicate queue", () => {
  it("names both sides and routes each encoded id through the safe detail surface", async () => {
    render(
      <ApiClientProvider value={client()}>
        <DuplicatesPage />
      </ApiClientProvider>,
    );

    expect(await screen.findByRole("columnheader", { name: "Your listing" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Matched against" })).toBeTruthy();

    expect(screen.getByRole("link", { name: "My First Round" }).getAttribute("href")).toBe(
      "/listings/mine%3Afirst%20round",
    );
    expect(screen.getByRole("link", { name: "My Second Round" }).getAttribute("href")).toBe(
      "/listings/mine%3Asecond%20round",
    );
    expect(screen.getByRole("link", { name: "Public Round" }).getAttribute("href")).toBe(
      "/opportunities/public%3Around%20one",
    );
    expect(screen.getByRole("link", { name: "Private Round" }).getAttribute("href")).toBe(
      "/listings/private%3Around%20two",
    );

    expect(screen.queryByText(/cannot say which/i)).toBeNull();
    expect(screen.queryByText(/reports the other side.*not which of yours/i)).toBeNull();
  });
});
