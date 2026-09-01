import { NOINDEX_ROUTE_PREFIXES } from "@/lib/noindex-routes";
import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * Allow the public surface, disallow the workbench — but only on the declared canonical origin;
 * every other host gets `Disallow: /` rather than ranking as a duplicate of the real site.
 *
 * `Allow: /` alongside the workbench `Disallow` rules is not a contradiction: robots.txt resolves
 * conflicts by longest match, not by rule order.
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
