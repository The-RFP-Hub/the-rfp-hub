import { readConfig } from "@/lib/config";

/**
 * The public surfaces fetch after hydration, so with scripting off they are an empty shell — and so
 * they are to a crawler that does not execute JavaScript. The data is public JSON, so the honest
 * fallback is to name the endpoint it comes from.
 */
export function NoScriptNotice() {
  const config = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
  const endpoint = config.ok ? `${config.config.apiBaseUrl}/v1/opportunities` : null;

  return (
    <noscript>
      <p className="callout">
        This page builds its list in the browser, so it needs JavaScript. The same data is public
        JSON:{" "}
        {endpoint ? (
          <a href={endpoint}>{endpoint}</a>
        ) : (
          <>
            the <code>/v1/opportunities</code> route of the API named by{" "}
            <code>NEXT_PUBLIC_API_URL</code>, which this deployment has not set.
          </>
        )}
      </p>
    </noscript>
  );
}
