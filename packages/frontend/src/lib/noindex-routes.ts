/**
 * The workbench and auth-mechanics route prefixes — every route this app serves that needs a
 * session to show anything, plus /dashboard and /auth/complete which do not strictly require one
 * but exist purely to gate into or complete a session, not to be read by a stranger arriving from
 * search. None of these are indexable, on ANY origin, including the canonical production one.
 *
 * THIS IS UNCONDITIONAL, unlike the public routes' index/follow (`lib/root-metadata.ts`, which
 * turns on only when the request matches `NEXT_PUBLIC_SITE_ORIGIN`). A workbench page renders an
 * empty shell to a crawler anyway (no session, no data — see the frontend README's known gaps), so
 * there is no environment in which indexing it would be correct.
 *
 * ONE LIST, TWO CONSUMERS, kept from drifting apart:
 *
 *   `NOINDEX_ROBOTS` is the `robots` value each of these routes' OWN top-level `layout.tsx` sets.
 *   Next's metadata merge means a NESTED route that does not set its own `robots` inherits the
 *   nearest ancestor's — so `/listings/[id]`, `/listings/[id]/edit` and `/listings/new` all inherit
 *   it from `src/app/listings/layout.tsx`, and `/organizations/[slug]` inherits it from
 *   `src/app/organizations/layout.tsx`, without needing their own copy.
 *
 *   `NOINDEX_ROUTE_PREFIXES` is the same set reduced to first path segments, for `robots.ts`'s
 *   `Disallow` rules — a crawler that ignores `<meta name="robots">` on a signed-out render of one
 *   of these pages still gets turned away at the crawl itself.
 *
 * `test/route-metadata.test.ts` asserts this list is exactly "every page route this app serves,
 * minus the public ones" — see that file for the public set and for the per-route layout check.
 */
export const NOINDEX_ROBOTS = { index: false, follow: false } as const;

export const NOINDEX_ROUTE_PREFIXES = [
  "/account",
  "/admin",
  "/auth",
  "/dashboard",
  "/duplicates",
  "/keys",
  "/listings",
  "/notifications",
  "/organisations",
  "/organizations",
  "/review",
] as const;
