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
   * INDEXING STAYS OFF, even though half of this app is now public.
   *
   * It is not a statement about the directory's audience; it is a statement about this deployment.
   * Nothing here is served from a canonical public host yet — there is no pipeline and no registered
   * domain for it (see the deployment section of the README) — and a preview URL that indexes is a
   * preview URL competing with the real one for every listing it carries. Turning this on is an
   * operator decision to take once the directory has an address worth indexing, not a default to
   * inherit from a build.
   */
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
