"use client";

/**
 * The provider tree: the API client bound to the stored session, and the one place the sign-in
 * panel is rendered.
 *
 * REPLACES `privy-root.tsx`, AND DROPS ITS `ssr: false` DANCE. The old provider had to be loaded
 * browser-only because a third-party SDK restored a session from browser storage on first render
 * and would otherwise render one tree on the server and a different one in the browser. Nothing
 * here does that: the session is a token read from `localStorage` inside an effect, and the server
 * pass renders the signed-out shell truthfully because on the server nobody IS signed in. So this
 * is an ordinary import, and the "Loading…" placeholder the dynamic import needed is gone with it.
 *
 * WHY THE PANEL LIVES HERE. `SessionState.login()` is a `() => void` called from the header, from
 * the gate on every private page and from the directory's publisher card. Keeping its signature is
 * what made this migration invisible to those consumers, so the panel has to be openable from
 * anywhere without a route change and without threading a prop through the tree — which is a
 * context, provided once, at the root.
 */
import { SignIn } from "@/components/SignIn";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import { createApiClient } from "./api";
import { ApiClientProvider } from "./api-context";
import { readSessionToken } from "./auth-client";

/**
 * Opening the sign-in panel.
 *
 * The default is a no-op rather than a throw, and that is deliberate: `useSession()` is called by
 * `RequireSession`, which a unit test renders on its own with only an API client around it. A throw
 * would make every one of those tests need a provider they are not testing. The consequence is
 * named rather than hidden — outside `<AppProviders>` there is no panel to open, so `login()` does
 * nothing, and nothing in the shipped app renders outside it.
 */
const SignInContext = createContext<() => void>(() => {});

export function useSignInOpener(): () => void {
  return useContext(SignInContext);
}

export function AuthRoot({ apiBaseUrl, children }: { apiBaseUrl: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // One client per base URL. `readSessionToken` is called per request rather than captured, so a
  // session that arrives after this client was built — a sign-in, or the Google handoff — is picked
  // up on the very next call without rebuilding anything.
  const [api] = useState(() =>
    createApiClient({ baseUrl: apiBaseUrl, getToken: async () => readSessionToken() }),
  );

  const openSignIn = useCallback(() => setOpen(true), []);
  const closeSignIn = useCallback(() => setOpen(false), []);

  // Escape closes it. A panel that traps a reader with no keyboard way out is a worse failure than
  // no panel, and this one can be opened from a header button on a public page.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <SignInContext.Provider value={openSignIn}>
      <ApiClientProvider value={api}>
        {children}
        {open ? (
          <div className="overlay">
            {/*
              `<dialog open>` rather than `showModal()`, and NOT `aria-modal`.

              The element carries the dialog role natively, which is why it is the right tag. What it
              is not is MODAL: `showModal()` is what puts a dialog in the top layer and makes the rest
              of the page inert, and it is unimplemented in the jsdom version this package tests
              under — a panel that throws in every unit test is worse than one that is honest about
              its behaviour. So the background is dimmed and Escape closes it, but focus is not
              trapped, and claiming `aria-modal="true"` would tell a screen reader the rest of the
              page is unavailable when it is still perfectly reachable.
            */}
            <dialog open className="card overlay-panel" aria-labelledby="signin-heading">
              <SignIn apiBaseUrl={apiBaseUrl} onSignedIn={closeSignIn} />
              <p>
                <button type="button" onClick={closeSignIn}>
                  Close
                </button>
              </p>
            </dialog>
          </div>
        ) : null}
      </ApiClientProvider>
    </SignInContext.Provider>
  );
}
