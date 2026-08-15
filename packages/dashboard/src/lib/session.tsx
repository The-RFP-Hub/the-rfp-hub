"use client";

/**
 * The session: who is logged in, and what the API says they may do.
 *
 * WHO DECIDES WHAT. The auth SDK decides whether somebody is signed in. The API decides what they
 * may do — `GET /v1/me` returns `canManageKeys`, `canReview` and `canAdmin`, and those flags are
 * what the navigation and the capability gates render from. Nothing here computes a capability
 * locally: a client that decided its own permissions would drift from the server the moment a role
 * changed, and would be advisory anyway, because every gate is enforced on the API.
 */
import { AuthBoundary } from "@/components/ErrorBoundary";
import { usePrivy } from "@privy-io/react-auth";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useApi } from "./api-context";
import { readConfig } from "./config";
import { type Resource, useResource } from "./resource";
import type { Me } from "./types";

export { useApi, ApiClientProvider } from "./api-context";

/**
 * Browser-only. The SDK restores its session from browser storage, so a server render would render
 * the signed-out shell and then replace it — and, worse, would invite somebody to add a server-side
 * notion of the current user. See `privy-root.tsx`.
 */
const PrivyRoot = dynamic(() => import("./privy-root"), {
  ssr: false,
  loading: () => <p className="state">Loading the dashboard…</p>,
});

export interface SessionState {
  /** The SDK has finished restoring any stored session. Nothing about auth is knowable before it. */
  ready: boolean;
  authenticated: boolean;
  /**
   * The SDK could not initialise — its service is unreachable, or it does not recognise this
   * application. It stays `ready: false` forever in that case, so a page that only branches on
   * `ready` waits for something that will never arrive. This is the difference between "restoring
   * your session" and "sign-in is broken", and a dashboard that cannot tell them apart shows a
   * spinner to somebody whose only useful next step is to talk to an operator.
   */
  error: Error | null;
  login: () => void;
  logout: () => Promise<void>;
  /** The API's answer about this account — a state with loading and failure branches, not a value. */
  me: Resource<Me>;
  reloadMe: () => void;
}

export function useSession(): SessionState {
  const { ready, authenticated, login, logout, error } = usePrivy();
  const api = useApi();
  const loadMe = useCallback(() => api.me.get(), [api]);
  const { state, reload } = useResource(loadMe, { enabled: ready && authenticated });
  return {
    ready,
    authenticated,
    error,
    // Wrapped, because the SDK's own `login` takes a click event as its first argument and passing
    // one through as options is how a button ends up opening the wrong modal.
    login: () => login(),
    logout,
    me: state,
    reloadMe: reload,
  };
}

/**
 * The root provider. When the build is misconfigured it renders the problem INSTEAD of the app:
 * mounting the tree anyway produces a login button that silently does nothing, which is the least
 * debuggable thing this package could ship.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const result = readConfig({
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  });

  if (!result.ok) {
    return (
      <main className="shell-main">
        <h1>This dashboard is not configured</h1>
        <p>
          These variables are read when the dashboard is <strong>built</strong>, so setting them on
          the running host is not enough — rebuild with them present.
        </p>
        <ul>
          {result.problems.map((problem) => (
            <li key={problem.variable}>
              <code>{problem.variable}</code> — {problem.problem}
            </li>
          ))}
        </ul>
        <p className="muted">
          <code>packages/dashboard/README.md</code> lists every variable, and explains why each
          environment needs its own auth application rather than sharing one.
        </p>
      </main>
    );
  }

  return (
    <AuthBoundary>
      <PrivyRoot appId={result.config.privyAppId} apiBaseUrl={result.config.apiBaseUrl}>
        {children}
      </PrivyRoot>
    </AuthBoundary>
  );
}
