/**
 * The workbench and auth-mechanics routes: not indexable on any origin, the canonical one included.
 * `NOINDEX_ROBOTS` is what each prefix's top-level `layout.tsx` sets and nested routes inherit;
 * `NOINDEX_ROUTE_PREFIXES` is the same set as `robots.ts` `Disallow` rules, for a crawler that
 * ignores the meta tag. `test/route-metadata.test.ts` keeps them in agreement with the route tree.
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
