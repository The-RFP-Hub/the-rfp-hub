import { AdminSubmitterTransfer } from "@/components/SubmitterTransfer";
import { type ApiClient, ApiError } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const recipient = { id: 42, handle: "ana", displayName: "Ana", email: "ana@example.org" };
function setup({
  accounts = [recipient],
  assign = vi.fn(async () => ({})),
  search = vi.fn(async () => ({ items: accounts })),
} = {}) {
  const reload = vi.fn();
  const api = {
    review: { accounts: search },
    admin: { assignSubmitter: assign },
  } as unknown as ApiClient;
  render(
    <ApiClientProvider value={api}>
      <AdminSubmitterTransfer
        id="acme:round 4"
        currentName="Acme"
        currentAccountId={7}
        onTransferred={reload}
      />
    </ApiClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change submitter" }));
  return { search, assign, reload };
}
async function choose() {
  fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "ana" } });
  fireEvent.click(screen.getByRole("button", { name: "Search accounts" }));
  fireEvent.change(await screen.findByLabelText("New submitter"), { target: { value: "42" } });
  fireEvent.change(screen.getByLabelText("Reason for this change"), {
    target: { value: "  Correct attribution  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
}
describe("Administrative submitter transfer", () => {
  it("requires a recipient and reason, confirms the change, and submits an account ID", async () => {
    const { search, assign, reload } = setup();
    expect(screen.getByLabelText("Find an account")).toBe(document.activeElement);
    expect(screen.getByRole("button", { name: "Review change" })).toHaveProperty("disabled", true);
    await choose();
    expect(search).toHaveBeenCalledWith({ q: "ana", limit: 10 });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText(/does not add organization membership/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change submitter" }));
    await screen.findByText("The program’s submitter has been updated.");
    expect(assign).toHaveBeenCalledWith("acme:round 4", {
      accountId: 42,
      reason: "Correct attribution",
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("preserves the recipient and reason after a failure and prevents duplicate submissions", async () => {
    let answer: ((value: unknown) => void) | undefined;
    const assign = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "unavailable", "Please try again."))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
    const { reload } = setup({ assign });
    await choose();
    fireEvent.click(screen.getByRole("button", { name: "Change submitter" }));
    await screen.findByText("Please try again.", { selector: "output" });
    fireEvent.click(screen.getByRole("button", { name: "Change submitter" }));
    expect(screen.getByRole("button", { name: "Updating submitter…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(assign).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => answer?.({}));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]).toEqual(assign.mock.calls[1]);
  });
  it("handles empty results and clears the selected recipient when the query changes", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [recipient] });
    setup({ search });
    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search accounts" }));
    await screen.findByText("No accounts matched. Try another name or handle.");
    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Search accounts" }));
    fireEvent.change(await screen.findByLabelText("New submitter"), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "other" } });
    expect(screen.queryByLabelText("New submitter")).toBeNull();
    expect(screen.getByRole("button", { name: "Review change" })).toHaveProperty("disabled", true);
  });
});
