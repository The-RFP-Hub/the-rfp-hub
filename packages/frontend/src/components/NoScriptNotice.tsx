import { readConfig } from "@/lib/config";

/**
 * What a reader without JavaScript is told, on a page that has nothing else to show them.
 *
 * The public surfaces fetch after hydration, so with scripting off they are an empty shell — and so
 * they are to any crawler that does not execute JavaScript, on the origin the robots rules now let
 * one index. The data is public, unauthenticated JSON, so the honest fallback is to name the
 * endpoint it comes from rather than to leave the reader looking at a heading.
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
