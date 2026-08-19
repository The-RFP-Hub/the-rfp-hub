"use client";

/**
 * The API client's React context, alone in its own module.
 *
 * It is separate from `auth-root.tsx` so that a test — and the analytics and directory render tests
 * in particular — can provide a stub client to a subtree without pulling in the auth client, and
 * separate from `session.tsx` so importing the context does not drag the provider tree with it.
 */
import { createContext, useContext } from "react";
import type { ApiClient } from "./api";

const ApiContext = createContext<ApiClient | null>(null);

/** Wrap a subtree in a client. Tests pass a stub; the app passes the session-bound one. */
export const ApiClientProvider = ApiContext.Provider;

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error(
      "useApi() was called outside <AppProviders>. Every page in this package must render inside it.",
    );
  }
  return client;
}
