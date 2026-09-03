import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * The public sitemap, emitted only on the declared canonical origin. Not the opportunities —
 * enumerating them means paginating the whole directory on every crawl, and a crawler that finds `/`
 * finds them anyway. `lastModified` is omitted: stamping "now" would be a fabricated signal.
 */
const ROUTES = ["/", "/how-it-works", "/publishers", "/privacy", "/terms"] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!(await isCanonicalRequest())) return [];
  const origin = canonicalSiteOrigin();
  if (!origin) return [];
  return ROUTES.map((path) => ({ url: `${origin}${path}` }));
}
