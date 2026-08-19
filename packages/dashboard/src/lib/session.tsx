"use client";

/**
 * The session: who is logged in, and what the API says they may do.
 *
 * WHO DECIDES WHAT. Better-Auth, mounted on the API, decides whether somebody is signed in. The API
 * decides what they may do — `GET /v1/me` returns `canManageKeys`, `canReview` and `canAdmin`, and
 * those flags are what the navigation and the capability gates render from. Nothing here computes a
 * capability locally: a client that decided its own permissions would drift from the server the
 * moment a role changed, and would be advisory anyway, because every gate is enforced on the API.
 *
 * `SessionState` KEPT ITS SHAPE THROUGH THE PROVIDER SWAP, and that was the design constraint
 * rather than a happy accident: `Chrome`, `RequireSession`, the directory's publisher card and the
 * dashboard overview all branch on these seven members, and none of them needed a line changed.
 * What moved is entirely behind this function.
 */
import { AuthBoundary } from "@/components/ErrorBoundary";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useApi } from "./api-context";
import { authClient, clearSessionToken, refreshSession } from "./auth-client";
import { AuthRoot, useSignInOpener } from "./auth-root";
import { readConfig } from "./config";
import { type Resource, useResource } from "./resource";
import type { Me } from "./types";

export { useApi, ApiClientProvider } from "./api-context";

export interface SessionState {
  /** The session read has settled. Nothing about auth is knowable before it. */
  ready: boolean;
  authenticated: boolean;
  /**
   * The auth service could not be REACHED — the API is down, or the browser could not talk to it.
   * It stays `ready: false` in that case, so a page that only branches on `ready` waits for
   * something that will never arrive. This is the difference between "restoring your session" and
   * "sign-in is broken", and a dashboard that cannot tell them apart shows a spinner to somebody
   * whose only useful next step is to talk to an operator.
   *
   * NOT set for "you are signed out": a session read with no token, or with a stale one, is a
   * successful answer of `null` and is exactly the state the sign-in panel exists for.
   */
  error: Error | null;
  login: () => void;
  logout: () => Promise<void>;
  /** The API's answer about this account — a state with loading and failure branches, not a value. */
  me: Resource<Me>;
  reloadMe: () => void;
}

export function useSession(): SessionState {
  const query = authClient.useSession();
  const openSignIn = useSignInOpener();
  const api = useApi();

  const loadMe = useCallback(() => api.me.get(), [api]);
  const ready = !query.isPending && !query.error;
  const authenticated = Boolean(query.data);
  const { state, reload } = useResource(loadMe, { enabled: ready && authenticated });

  const logout = useCallback(async () => {
    // Server first, storage second. Reversing them would leave a revocable session alive on the
    // server with no token left to revoke it with — a sign-out that only looks like one.
    try {
      await authClient.signOut();
    } catch (cause) {
      // BEST-EFFORT, AND IT DOES NOT REJECT. Every consumer fires this and forgets it
      // (`onClick={() => void session.logout()}`), so re-throwing here bought nobody a handler and
      // cost an unhandled rejection on every failed sign-out. The local half below is what the user
      // asked for and it cannot fail; the server session, if the call really did not land, expires
      // on its own. Logged rather than swallowed, because "the API was unreachable" is worth
      // knowing and there is no error surface on a sign-out button to put it on.
      console.warn(
        "Sign-out could not be confirmed with the API; clearing this browser anyway.",
        cause,
      );
    } finally {
      clearSessionToken();
      // ON BOTH PATHS, and the failing one is why this is here rather than left to the library.
      // Better-Auth refreshes `useSession` from its `/sign-out` atom listener, which fires on
      // SUCCESS. When the request fails — the API is unreachable, or answers 5xx — the token is
      // still gone locally, and without this the tab would keep rendering signed-in navigation and
      // capability gates while every request it makes is now anonymous and 401s.
      refreshSession();
    }
  }, []);

  return {
    ready,
    authenticated,
    // better-fetch reports a failure as a plain object, not an `Error`. Consumers render
    // `error.message`, so it is turned into a real one here rather than at four call sites.
    error: query.error ? new Error(describeSessionFailure(query.error)) : null,
    login: openSignIn,
    logout,
    me: state,
    reloadMe: reload,
  };
}

/** What went wrong reaching the auth service, in a sentence an operator can act on. */
function describeSessionFailure(error: { status?: number; message?: string }): string {
  const message = error.message?.trim();
  if (message) return message;
  return error.status
    ? `The API answered ${error.status} when asked who is signed in.`
    : "The API could not be reached to check whether you are signed in.";
}

/**
 * The root provider. When the build is misconfigured it renders the problem INSTEAD of the app:
 * mounting the tree anyway produces a login button that silently does nothing, which is the least
 * debuggable thing this package could ship.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const result = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });

  if (!result.ok) {
    return (
      <main className="shell-main">
        <h1>This dashboard is not configured</h1>
        <p>
          This variable is read when the dashboard is <strong>built</strong>, so setting it on the
          running host is not enough — rebuild with it present.
        </p>
        <ul>
          {result.problems.map((problem) => (
            <li key={problem.variable}>
              <code>{problem.variable}</code> — {problem.problem}
            </li>
          ))}
        </ul>
        <p className="muted">
          <code>packages/dashboard/README.md</code> lists it, and explains why the API origin is
          also written into the page&rsquo;s Content-Security-Policy.
        </p>
      </main>
    );
  }

  return (
    <AuthBoundary>
      <AuthRoot apiBaseUrl={result.config.apiBaseUrl}>{children}</AuthRoot>
    </AuthBoundary>
  );
}
