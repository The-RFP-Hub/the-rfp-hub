import { Chrome } from "@/components/Chrome";
import { NavigationBlockerProvider } from "@/components/NavigationBlocker";
import { fontVariables } from "@/lib/fonts";
import { AppProviders } from "@/lib/session";
import "./globals.css";

/**
 * `generateMetadata`, NOT a static `metadata` object — because `robots` is the one field here that
 * cannot be a build-time constant any more, and its logic lives in `lib/root-metadata.ts` (see that
 * file's own comment for why it is not defined inline: it needs to be importable without also
 * importing `next/font/google` by way of `lib/fonts.ts` below, which has no transform under this
 * package's test runner).
 *
 * INDEXING IS CONDITIONAL ON THE CANONICAL ORIGIN, not unconditionally on. It was off while nothing
 * here was served from a canonical public host at all — a preview URL that indexed would compete
 * with the real one for every listing it carries — and that reasoning has not gone away, it has
 * just moved from "no deployment qualifies" to "exactly one does". See `lib/site-origin.ts` for the
 * mechanism: staging and every Vercel preview leave `NEXT_PUBLIC_SITE_ORIGIN` unset, so they stay
 * `noindex` — the fail-closed direction: forgetting to set the variable costs production its
 * indexing rather than costing staging its privacy.
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
        <AppProviders>
          <NavigationBlockerProvider>
            <Chrome>{children}</Chrome>
          </NavigationBlockerProvider>
        </AppProviders>
      </body>
    </html>
  );
}
