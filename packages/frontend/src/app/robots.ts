import { NOINDEX_ROUTE_PREFIXES } from "@/lib/noindex-routes";
import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * Allow the public surface, disallow the workbench — but ONLY on the declared canonical origin.
 * Every other host this app answers on (staging, a Vercel preview, a self-hosted copy that has not
 * set `NEXT_PUBLIC_SITE_ORIGIN`) gets a blanket `Disallow: /`, because indexing a duplicate of the
 * real site is worse than a crawler finding nothing at all — search engines penalize exactly that
 * kind of duplicate content, and a preview URL that ranked would compete with the real one for
 * every listing it carries.
 *
 * `NOINDEX_ROUTE_PREFIXES` (`lib/noindex-routes.ts`) IS DISALLOWED EVEN ON THE CANONICAL ORIGIN.
 * The root layout's `<meta name="robots">` is `index: true` there, and Next's metadata merge means
 * a route that does not override it inherits that — every workbench and auth route DOES override it
 * (same module, `NOINDEX_ROBOTS`), but a crawler that ignores the meta tag on a signed-out render of
 * one of those pages still needs to be turned away at the crawl itself. A longer, more specific
 * `Disallow` rule wins over the blanket `Allow: /` per the robots.txt spec (Google and every other
 * major crawler resolve conflicts by matching the longest rule, not by rule order), so listing both
 * here is correct rather than contradictory.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!(await isCanonicalRequest())) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const origin = canonicalSiteOrigin();
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...NOINDEX_ROUTE_PREFIXES] },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
