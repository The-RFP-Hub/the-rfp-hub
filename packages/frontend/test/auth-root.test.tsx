import { useSignInOpener } from "@/lib/auth-root";
import { AuthRoot } from "@/lib/auth-root";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/SignIn", () => ({
  SignIn: ({ onSignedIn }: { onSignedIn?: () => void }) => (
    <div className="signin">
      <h2 id="signin-heading">Sign in</h2>
      <label htmlFor="signin-email">Email address</label>
      <input id="signin-email" />
      <button type="button" onClick={onSignedIn}>
        Complete sign-in
      </button>
    </div>
  ),
}));

function Opener() {
  const openSignIn = useSignInOpener();
  return (
    <button type="button" onClick={openSignIn}>
      Log in
    </button>
  );
}

function ClaimLikeOpener() {
  const openSignIn = useSignInOpener();
  const [signedIn, setSignedIn] = useState(false);
  return (
    <details open>
      <summary>This is my programme — claim it</summary>
      {signedIn ? (
        <select aria-label="Organisation">
          <option>Acme</option>
        </select>
      ) : (
        <button
          type="button"
          onClick={() => {
            openSignIn();
            window.addEventListener("auth-root-test-signed-in", () => setSignedIn(true), {
              once: true,
            });
          }}
        >
          Sign in to claim
        </button>
      )}
    </details>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the sign-in dialog", () => {
  it("opens modally, focuses email, closes on cancel, and restores the opener", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(
      <AuthRoot apiBaseUrl="https://api.example.com">
        <main id="main-content" tabIndex={-1}>
          <Opener />
        </main>
      </AuthRoot>,
    );

    const opener = screen.getByRole("button", { name: "Log in" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("moves focus into a claim form when sign-in replaces its opener", async () => {
    render(
      <AuthRoot apiBaseUrl="https://api.example.com">
        <main id="main-content" tabIndex={-1}>
          <ClaimLikeOpener />
        </main>
      </AuthRoot>,
    );

    const opener = screen.getByRole("button", { name: "Sign in to claim" });
    opener.focus();
    fireEvent.click(opener);
    const complete = await screen.findByRole("button", { name: "Complete sign-in" });
    fireEvent(window, new Event("auth-root-test-signed-in"));
    fireEvent.click(complete);

    const organisation = await screen.findByRole("combobox", { name: "Organisation" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(organisation);
  });

  it("stays open when Strict Mode replays the dialog layout effect", async () => {
    render(
      <StrictMode>
        <AuthRoot apiBaseUrl="https://api.example.com">
          <main id="main-content" tabIndex={-1}>
            <Opener />
          </main>
        </AuthRoot>
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
  });
});
