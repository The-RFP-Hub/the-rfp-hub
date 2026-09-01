import { Chrome } from "@/components/Chrome";
import { GoogleAnalytics } from "@/components/GoogleAnalytics";
import { NavigationBlockerProvider } from "@/components/NavigationBlocker";
import { fontVariables } from "@/lib/fonts";
import { AppProviders } from "@/lib/session";
import "./globals.css";

/**
 * `generateMetadata`, not a static `metadata`: `robots` depends on the request (`lib/site-origin.ts`).
 * It lives in its own module so a unit test can import it without `next/font/google`, which has no
 * transform under this package's test runner.
 */
export { generateMetadata } from "@/lib/root-metadata";

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
        {/*
         * Analytics is a PER-DEPLOYMENT decision, not a repository default: it renders only where
         * `NEXT_PUBLIC_GA_ID` is set, and `lib/csp.ts` opens the Google origins on the same
         * condition. The variable must be the literal `process.env.` expression — it is inlined at
         * build time (see `lib/config.ts`).
         */}
        {process.env.NEXT_PUBLIC_GA_ID && (
          <GoogleAnalytics measurementId={process.env.NEXT_PUBLIC_GA_ID} />
        )}
        <AppProviders>
          <NavigationBlockerProvider>
            <Chrome>{children}</Chrome>
          </NavigationBlockerProvider>
        </AppProviders>
      </body>
    </html>
  );
}
