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
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  const opener = useRef<HTMLElement | null>(null);
  const openerDisclosure = useRef<HTMLDetailsElement | null>(null);
  const restoreAfter = useRef<"dismiss" | "signed-in" | null>(null);

  // One client per base URL. `readSessionToken` is called per request rather than captured, so a
  // session that arrives after this client was built — a sign-in, or the Google handoff — is picked
  // up on the very next call without rebuilding anything.
  const [api] = useState(() =>
    createApiClient({ baseUrl: apiBaseUrl, getToken: async () => readSessionToken() }),
  );

  const openSignIn = useCallback(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
    openerDisclosure.current = opener.current?.closest("details") ?? null;
    setOpen(true);
  }, []);

  const closeSignIn = useCallback((reason: "dismiss" | "signed-in") => {
    restoreAfter.current = reason;
    setOpen(false);
  }, []);

  /*
   * Native dialogs restore focus to the opener when they close, but the sign-in success commit can
   * remove that opener: the public claim control replaces its signed-out button with the claim
   * fields. Restore after React has committed the closed state, and keep watching that disclosure
   * if the session tree follows in a later commit. The stable `<details>` is intentionally captured
   * when the dialog opens; once its button is detached, `closest()` can no longer find it.
   */
  useLayoutEffect(() => {
    const reason = restoreAfter.current;
    if (open || !reason) return;
    restoreAfter.current = null;

    const trigger = opener.current;
    const disclosure = openerDisclosure.current;
    const focusFallback = () => {
      const next = disclosure?.isConnected
        ? (firstFocusableInside(disclosure, trigger) ?? disclosure.querySelector("summary"))
        : null;
      const target = next ?? document.querySelector<HTMLElement>("#main-content");
      target?.focus();
    };

    if (trigger?.isConnected) trigger.focus();
    else focusFallback();

    if (reason !== "signed-in" || !trigger?.isConnected || !disclosure?.isConnected) return;

    const observer = new MutationObserver(() => {
      if (trigger.isConnected) return;
      focusFallback();
      observer.disconnect();
    });
    observer.observe(disclosure, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);

  return (
    <SignInContext.Provider value={openSignIn}>
      <ApiClientProvider value={api}>
        {children}
        {open ? <SignInDialog apiBaseUrl={apiBaseUrl} onClosed={closeSignIn} /> : null}
      </ApiClientProvider>
    </SignInContext.Provider>
  );
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function firstFocusableInside(scope: HTMLElement, exclude: HTMLElement | null): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
      (candidate) => candidate !== exclude && candidate.tagName !== "SUMMARY",
    ) ?? null
  );
}

function SignInDialog({
  apiBaseUrl,
  onClosed,
}: {
  apiBaseUrl: string;
  onClosed: (reason: "dismiss" | "signed-in") => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeReason = useRef<"dismiss" | "signed-in">("dismiss");

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    element.querySelector<HTMLInputElement>("#signin-email")?.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const close = (reason: "dismiss" | "signed-in") => {
    closeReason.current = reason;
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      className="card overlay-panel"
      aria-labelledby="signin-heading"
      onCancel={(event) => {
        event.preventDefault();
        close("dismiss");
      }}
      onClose={() => {
        // React Strict Mode replays layout effects in development. Its cleanup closes this dialog,
        // but the browser queues that close event until after the replay has reopened it. Ignore
        // that stale event; a real dismissal always reaches this handler with `open === false`.
        if (!dialog.current?.open) onClosed(closeReason.current);
      }}
    >
      <SignIn apiBaseUrl={apiBaseUrl} onSignedIn={() => close("signed-in")} />
      <p>
        <button type="button" onClick={() => close("dismiss")}>
          Close
        </button>
      </p>
    </dialog>
  );
}
