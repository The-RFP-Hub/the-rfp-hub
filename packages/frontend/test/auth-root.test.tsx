import { useSignInOpener } from "@/lib/auth-root";
import { AuthRoot } from "@/lib/auth-root";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/SignIn", () => ({
  SignIn: ({ onSignedIn }: { onSignedIn?: () => void }) => (
    <div className="signin">
      <h2 id="signin-heading">Log in</h2>
      <label htmlFor="signin-email">Email address</label>
      <input id="signin-email" />
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new Event("auth-root-test-complete"));
          onSignedIn?.();
        }}
      >
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
      <summary>This is my program — claim it</summary>
      {signedIn ? (
        <select aria-label="Organization">
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

function RefreshingOpener() {
  const openSignIn = useSignInOpener();
  const [signedIn, setSignedIn] = useState(false);
  return signedIn ? (
    <span>Session refreshed</span>
  ) : (
    <button
      type="button"
      onClick={() => {
        openSignIn();
        window.addEventListener("auth-root-test-refresh", () => setSignedIn(true), { once: true });
      }}
    >
      Log in here
    </button>
  );
}

function LogoutCycleOpener() {
  const openSignIn = useSignInOpener();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    const complete = () => setSignedIn(true);
    window.addEventListener("auth-root-test-complete", complete);
    return () => window.removeEventListener("auth-root-test-complete", complete);
  }, []);
  return signedIn ? (
    <button type="button" onClick={() => setSignedIn(false)}>
      Log out
    </button>
  ) : (
    <button type="button" onClick={openSignIn}>
      Log in after logout
    </button>
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

    const organization = await screen.findByRole("combobox", { name: "Organization" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(organization);
  });

  it("moves focus to main content when a later session refresh replaces an ordinary opener", async () => {
    render(
      <AuthRoot apiBaseUrl="https://api.example.com">
        <main id="main-content" tabIndex={-1}>
          <RefreshingOpener />
        </main>
      </AuthRoot>,
    );

    const opener = screen.getByRole("button", { name: "Log in here" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Complete sign-in" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);

    fireEvent(window, new Event("auth-root-test-refresh"));
    await screen.findByText("Session refreshed");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
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

  it("opens again from a real handler after sign-in replaces the opener and logout restores it", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(
      <AuthRoot apiBaseUrl="https://api.example.com">
        <main id="main-content" tabIndex={-1}>
          <LogoutCycleOpener />
        </main>
      </AuthRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Log in after logout" }));
    fireEvent.click(await screen.findByRole("button", { name: "Complete sign-in" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    const login = await screen.findByRole("button", { name: "Log in after logout" });
    // This dispatches through the real mounted handler. The Playwright companion covers browser
    // hit-testing and native dialog inertness, which jsdom does not implement.
    fireEvent.click(login);
    const reopened = await screen.findByRole("dialog");
    expect(reopened.hasAttribute("open")).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(2);
  });
});
