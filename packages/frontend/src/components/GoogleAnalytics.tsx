/**
 * Google Analytics 4, as this app can actually carry it.
 *
 * The stock copy-paste snippet cannot work here: there is no static HTML file to paste it into,
 * and the CSP would refuse both halves of it — the external loader (an origin `script-src` does
 * not name by default) and the inline bootstrap (an inline script with no nonce). So the loader
 * is admitted through `lib/csp.ts`'s GA origins, and the bootstrap is emitted through
 * `next/script` carrying the SAME nonce `src/proxy.ts` minted for this request, read back off the
 * request headers it was stamped on. Both are conditional on `NEXT_PUBLIC_GA_ID` at the call site
 * in the layout; this component assumes the id is present.
 *
 * Route changes inside the SPA are reported by GA4's enhanced measurement (history-change page
 * views), which is a property-level setting in the GA console, not something configured here.
 */
import { headers } from "next/headers";
import Script from "next/script";

export async function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
        strategy="afterInteractive"
        nonce={nonce}
      />
      <Script id="ga-bootstrap" strategy="afterInteractive" nonce={nonce}>
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', ${JSON.stringify(measurementId)});`}
      </Script>
    </>
  );
}
