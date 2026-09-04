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

  it("makes the MCP path explicit and prepares the least-powerful submission key", async () => {
    mount();

    expect(await screen.findByRole("heading", { name: "Connect the RFP Hub MCP" })).toBeTruthy();
    expect(screen.getByText(/Search and fetch work anonymously/)).toBeTruthy();
    expect(screen.getByText(/model-provider agnostic/).textContent).toContain("stdio");
    for (const provider of ["Codex", "Claude", "Cursor", "VS Code"]) {
      expect(screen.queryByText(new RegExp(provider))).toBeNull();
    }
    expect(screen.getByText(/leave/).textContent).toContain("publish off");

    const guide = screen.getAllByRole("link", { name: "Open MCP setup guide (new tab)" })[0];
    expect(guide?.getAttribute("href")).toBe(
      "https://github.com/The-RFP-Hub/the-rfp-hub/blob/main/packages/mcp/README.md#submit-from-an-agent",
    );
    expect(guide?.getAttribute("target")).toBe("_blank");
    expect(guide?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("https://api.example.com")).toBeTruthy();
    const deploymentStep = screen.getByText("Point it at this deployment.").closest("li");
    expect(deploymentStep?.textContent).toContain("RFPHUB_API_BASE");

    fireEvent.click(screen.getByRole("button", { name: "Prepare an MCP key" }));
    const label = screen.getByLabelText("Label") as HTMLInputElement;
    expect(label.value).toBe("RFP Hub MCP");
    expect(document.activeElement).toBe(label);
    expect((screen.getByRole("checkbox", { name: /read/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /write/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: /publish/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Mint" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: "RFP Hub MCP", scopes: ["read", "write"] }),
    );
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
      "Revoked rfp_backup…. Audit rows naming it still resolve.",
    );
    expect(result.closest("tr")?.previousElementSibling).toBe(unlabelledRow);
    expect(screen.queryByRole("group", { name: "Revoke rfp_backup…?" })).toBeNull();
  });

  it("keeps a labelled revoke result by its row without overwriting the mint result", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(
      await screen.findByText("Key created. Copy it now; it will not be shown again."),
    ).toBeTruthy();

    const row = await productionRow();
    fireEvent.click(within(row).getByRole("button", { name: "Revoke…" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));

    const result = await screen.findByText(
      "Revoked Production ingest. Audit rows naming it still resolve.",
    );
    expect(result.closest("tr")?.previousElementSibling).toBe(row);
    expect(screen.getByText("Key created. Copy it now; it will not be shown again.")).toBeTruthy();
    expect(screen.queryByText(/Revoked 11/)).toBeNull();
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
  it("keeps the next MCP step beside the one-time secret without navigating away", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));

    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    expect(screen.getByText(/Using this key with the MCP/).textContent).toContain("RFPHUB_API_KEY");
    expect(screen.getByText(/Using this key with the MCP/).textContent).toContain(
      "Keep this page open",
    );
    const guide = screen.getAllByRole("link", { name: "Open MCP setup guide (new tab)" })[0];
    expect(guide?.getAttribute("target")).toBe("_blank");
  });

  it("reports a successful clipboard write and resets it for the next secret", async () => {
    create
      .mockResolvedValueOnce({ key: key({ id: 33 }), token: "rfp_secret_one" })
      .mockResolvedValueOnce({ key: key({ id: 44 }), token: "rfp_secret_two" });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    expect(
      await screen.findByText("Could not copy to the clipboard. Copy the secret manually."),
    ).toBeTruthy();
  });

  it("reports when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Mint" }));
    expect(await screen.findByText("rfp_secret_one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    expect(
      await screen.findByText("Clipboard access is unavailable. Copy the secret manually."),
    ).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
