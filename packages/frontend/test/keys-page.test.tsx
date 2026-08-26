/**
 * API KEY ACTIONS have two sharp edges the page must make visible: revocation immediately breaks
 * every integration still using the key, and clipboard writes are unavailable or reject in normal
 * browser conditions. These tests keep both actions staged and honest about their result.
 */
import KeysPage from "@/app/keys/page";
import { ApiError } from "@/lib/api";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import type { ApiKey, Me } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({ usePathname: () => "/keys" }));

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
  createdAt: "2026-01-01T00:00:00Z",
};

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 11,
  name: "Production ingest",
  keyPrefix: "rfp_prod",
  scopes: ["read", "write"],
  createdAt: "2026-08-01T00:00:00Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

const listedKeys = [key(), key({ id: 22, name: null, keyPrefix: "rfp_backup", scopes: ["read"] })];
const list = vi.fn(async () => ({ items: listedKeys }));
const create = vi.fn(async () => ({ key: key({ id: 33 }), token: "rfp_secret_one" }));
const revoke = vi.fn(async (id: number) => key({ id, revokedAt: "2026-08-25T12:00:00Z" }));
const writeText = vi.fn(async (_value: string) => undefined);

function client(): ApiClient {
  return {
    baseUrl: "https://api.example.com",
    me: { get: async () => me },
    keys: { list, create, revoke },
  } as unknown as ApiClient;
}

const mount = () =>
  render(
    <ApiClientProvider value={client()}>
      <KeysPage />
    </ApiClientProvider>,
  );

const productionRow = async () =>
  (await screen.findByText("Production ingest")).closest("tr") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

describe("the key page's action hierarchy", () => {
  it("makes the actual Mint control primary and uses a shared checkbox row", async () => {
    mount();

    expect((await screen.findByRole("button", { name: "Mint" })).className).toContain(
      "button-primary",
    );
    expect(screen.getByRole("checkbox", { name: /read/ }).closest("label")?.className).toContain(
      "choice-row",
    );
  });

  it("keeps the empty-state jump link secondary", async () => {
    list.mockResolvedValueOnce({ items: [] });
    mount();

    expect(
      (await screen.findByRole("link", { name: "Mint your first key" })).className,
    ).not.toContain("button-primary");
  });
});

describe("revoking a key", () => {
  it("stages the consequence on the first click without revoking", async () => {
    mount();

    fireEvent.click(within(await productionRow()).getByRole("button", { name: "Revoke…" }));

    const panel = screen.getByRole("group", { name: "Revoke Production ingest?" });
    expect(within(panel).getByText(/stop authenticating immediately/)).toBeTruthy();
    expect(within(panel).getByText(/Revocation cannot be undone/)).toBeTruthy();
    expect(within(panel).getByText(/create the replacement, deploy it, then revoke/)).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("cancels without calling the API", async () => {
    mount();

    fireEvent.click(within(await productionRow()).getByRole("button", { name: "Revoke…" }));
    const panel = screen.getByRole("group", { name: "Revoke Production ingest?" });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));

    expect(revoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Revoke Production ingest?" })).toBeNull();
  });

  it("revokes the intended key and falls back to its prefix when it has no label", async () => {
    mount();

    const unlabelledRow = (await screen.findByText("(unlabelled)")).closest("tr") as HTMLElement;
    fireEvent.click(within(unlabelledRow).getByRole("button", { name: "Revoke…" }));
    const panel = screen.getByRole("group", { name: "Revoke rfp_backup…?" });
    fireEvent.click(within(panel).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith(22));
    const result = await screen.findByText(
      "Key rfp_backup… revoked. Audit rows naming it still resolve.",
    );
    expect(result.closest("tr")?.previousElementSibling).toBe(unlabelledRow);
    expect(screen.queryByRole("group", { name: "Revoke rfp_backup…?" })).toBeNull();
  });

  it("keeps a labelled revoke result by its row without overwriting the mint result", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("Key created. The secret above is shown once.")).toBeTruthy();

    const row = await productionRow();
    fireEvent.click(within(row).getByRole("button", { name: "Revoke…" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));

    const result = await screen.findByText(
      "Key Production ingest revoked. Audit rows naming it still resolve.",
    );
    expect(result.closest("tr")?.previousElementSibling).toBe(row);
    expect(screen.getByText("Key created. The secret above is shown once.")).toBeTruthy();
    expect(screen.queryByText(/Key 11 revoked/)).toBeNull();
  });

  it("shows and disables the busy confirmation while revocation is in flight", async () => {
    revoke.mockImplementationOnce(() => new Promise<ApiKey>(() => undefined));
    mount();

    fireEvent.click(within(await productionRow()).getByRole("button", { name: "Revoke…" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));

    const busy = screen.getByRole("button", { name: "Revoking…" });
    expect(busy).toHaveProperty("disabled", true);
  });

  it("keeps the panel open and reports an API failure", async () => {
    revoke.mockRejectedValueOnce(new ApiError(503, "unavailable", "Key service unavailable."));
    mount();

    fireEvent.click(within(await productionRow()).getByRole("button", { name: "Revoke…" }));
    const panel = screen.getByRole("group", { name: "Revoke Production ingest?" });
    fireEvent.click(within(panel).getByRole("button", { name: "Revoke key" }));

    expect(
      await screen.findByText("Key service unavailable.", { selector: "output" }),
    ).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("unavailable")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Revoke Production ingest?" })).toBeTruthy();
  });
});

describe("copying a newly minted secret", () => {
  it("reports a successful clipboard write and resets it for the next secret", async () => {
    create
      .mockResolvedValueOnce({ key: key({ id: 33 }), token: "rfp_secret_one" })
      .mockResolvedValueOnce({ key: key({ id: 44 }), token: "rfp_secret_two" });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("rfp_secret_one"));
    expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_two")).toBeTruthy();
    expect(screen.queryByText("Copied to the clipboard.")).toBeNull();
  });

  it("reports a rejected clipboard write", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Could not copy to the clipboard. Copy the secret manually."),
    ).toBeTruthy();
  });

  it("reports when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Clipboard access is unavailable. Copy the secret manually."),
    ).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
