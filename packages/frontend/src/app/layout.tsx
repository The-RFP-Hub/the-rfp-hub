import { Chrome } from "@/components/Chrome";
import { NavigationBlockerProvider } from "@/components/NavigationBlocker";
import { fontVariables } from "@/lib/fonts";
import { AppProviders } from "@/lib/session";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Directory | RFP Hub",
    template: "%s | RFP Hub",
  },
  description:
    "An open index of funding opportunities under one standard: read it without an account, and — for publishers — submit and maintain listings, read their traffic, and run the review queues.",
  /*
   * INDEXING IS ON. It was off while nothing here was served from a canonical public host — a
   * preview URL that indexes competes with the real one for every listing it carries — and that
   * condition no longer holds: this deployment IS the canonical public host, and a public register
   * of funding opportunities with no search presence is failing the people it exists for. See the
   * README for the operator reasoning; a self-hosted copy on a domain that is not yet worth
   * indexing should override this back to `false` for its own build.
   */
  robots: { index: true, follow: true },
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

/**
 * The font variables go on `<html>`, once.
 *
 * `next/font` emits the `@font-face` rules and a class that declares `--font-display`,
 * `--font-body` and `--font-mono`; the stylesheet consumes those variables and nothing else knows
 * a family name. Putting the class on the root element is what puts them in scope for the whole
 * tree, including the sign-in dialog, which renders in a portal-free overlay but still inherits
 * from here. NOTHING IS FETCHED AT RUNTIME — see `lib/fonts.ts` for why `font-src 'self'` is
 * untouched by this.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <AppProviders>
          <NavigationBlockerProvider>
            <Chrome>{children}</Chrome>
          </NavigationBlockerProvider>
        </AppProviders>
      </body>
    </html>
  );
}
