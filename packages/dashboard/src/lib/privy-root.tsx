"use client";

/**
 * The auth SDK's provider and the API client bound to it, in their own module so they can be loaded
 * BROWSER-ONLY.
 *
 * WHY `ssr: false` AT THE CALL SITE (see `session.tsx`). The SDK restores a session from browser
 * storage and talks to its own origin; there is nothing for it to do on a server render, and a
 * server render of a signed-in dashboard would be a server render of a page whose content the
 * server is not allowed to know. Keeping it out of the server pass also means this package never
 * grows an accidental server-side notion of who is logged in — the API stays the only authority.
 */
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { type ReactNode, useMemo } from "react";
import { createApiClient } from "./api";
import { ApiClientProvider } from "./api-context";

function ApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const { getAccessToken } = usePrivy();
  // One client per base URL. `getAccessToken` is called per request, so a token refreshed mid-session
  // is picked up without rebuilding anything.
  const client = useMemo(
    () => createApiClient({ baseUrl, getToken: getAccessToken }),
    [baseUrl, getAccessToken],
  );
  return <ApiClientProvider value={client}>{children}</ApiClientProvider>;
}

export default function PrivyRoot({
  appId,
  apiBaseUrl,
  children,
}: {
  appId: string;
  apiBaseUrl: string;
  children: ReactNode;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Wallet-first, because a publisher's identity in this ecosystem is an address; email sits
        // beside it so an organisation's programme manager is not forced into holding one.
        loginMethods: ["wallet", "email"],
        appearance: { theme: "light" },
        // No embedded wallet is provisioned. This dashboard never signs anything — it exchanges the
        // session for an access token and nothing else — so creating a custodial wallet for every
        // visitor would be manufacturing an asset the product has no use for.
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
      }}
    >
      <ApiProvider baseUrl={apiBaseUrl}>{children}</ApiProvider>
    </PrivyProvider>
  );
}
