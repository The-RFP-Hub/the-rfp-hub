import { Chrome } from "@/components/Chrome";
import { AppProviders } from "@/lib/session";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RFP Hub publisher dashboard",
  description:
    "Submit and manage funding opportunities, read their traffic, and run the review queues.",
  // Nothing here is public, and none of it should be indexed even if a preview host is reachable.
  robots: { index: false, follow: false },
};

/**
 * EVERY PAGE IS RENDERED PER REQUEST, and it is the Content-Security-Policy that requires it.
 *
 * The framework emits inline bootstrap scripts and stamps them with the nonce it finds on the
 * incoming request — a nonce that `src/proxy.ts` mints fresh each time. A prerendered page has
 * no way to carry a nonce that a later request's header will match, so its inline scripts would be
 * blocked and the page would arrive inert. The alternatives were `'unsafe-inline'` for scripts,
 * which gives up the protection entirely, or no CSP at all.
 *
 * Nothing is lost by it: every page here is a browser client of the API, so there is no server-side
 * content to cache. The server pass renders the shell and nothing else.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>
          <Chrome>{children}</Chrome>
        </AppProviders>
      </body>
    </html>
  );
}
