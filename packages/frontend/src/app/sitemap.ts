import { listSitemapOpportunities } from "@/lib/api";
import { readConfig } from "@/lib/config";
import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * The public sitemap, emitted only on the declared canonical origin: the five static pages, then
 * every listed opportunity, read an hour at a time and capped far below the 50,000-URL limit. A
 * crawl must not depend on that read — an unreachable or malformed API leaves the statics standing.
 * `lastModified` is omitted on the statics, where "now" would be fabricated, and carried only when
 * the API reports one.
 */
const ROUTES = ["/", "/how-it-works", "/publishers", "/privacy", "/terms"] as const;

const MAX_OPPORTUNITY_URLS = 5_000;
const REVALIDATE_SECONDS = 3_600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!(await isCanonicalRequest())) return [];
  const origin = canonicalSiteOrigin();
  if (!origin) return [];

  const statics = ROUTES.map((path) => ({ url: `${origin}${path}` }));
  const config = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
  if (!config.ok) return statics;

  try {
    const entries = await listSitemapOpportunities({
      baseUrl: config.config.apiBaseUrl,
      maxUrls: MAX_OPPORTUNITY_URLS,
      revalidateSeconds: REVALIDATE_SECONDS,
    });
    return [
      ...statics,
      ...entries.map(({ id, updatedAt }) => ({
        url: `${origin}/opportunities/${encodeURIComponent(id)}`,
        ...(updatedAt ? { lastModified: updatedAt } : {}),
      })),
    ];
  } catch {
    return statics;
  }
}
