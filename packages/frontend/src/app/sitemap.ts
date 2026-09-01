import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * The whole public sitemap, as five static paths — emitted ONLY on the declared canonical origin.
 *
 * NOT THE OPPORTUNITIES. `GET /v1/opportunities` is unauthenticated and paginated, and giving every
 * listing its own `<url>` would mean fetching the whole directory on every crawl of
 * `/sitemap.xml` — a network call and a pagination loop this file does not need in order to be
 * correct. The five routes below are the whole of the app's STATIC surface: everything an anonymous
 * visitor can reach without picking a specific entry, which is exactly what a search engine needs
 * in order to find the directory and start crawling it on its own.
 *
 * The workbench routes (`/dashboard`, `/listings`, `/keys`, `/review`, `/admin`, …) are deliberately
 * absent: every one of them needs a session to show anything, so a crawler visiting one gets an
 * empty shell — the client-fetched content this package's README already names as a known gap.
 *
 * NO CANONICAL ORIGIN, NO SITEMAP. `isCanonicalRequest` (`lib/site-origin.ts`) is false on staging
 * and on every Vercel preview, because `NEXT_PUBLIC_SITE_ORIGIN` is set only for production — a
 * sitemap published from a duplicate host is exactly the kind of duplicate-content signal a search
 * engine penalizes, and an empty list is the correct, honest answer for a deployment this file does
 * not believe is the canonical one.
 *
 * `lastModified` IS DELIBERATELY OMITTED. This file has no idea when any of these pages last
 * changed — stamping "now" on every crawl would be a fabricated freshness signal, not a real one.
 */
const ROUTES = ["/", "/how-it-works", "/publishers", "/privacy", "/terms"] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!(await isCanonicalRequest())) return [];
  const origin = canonicalSiteOrigin();
  if (!origin) return [];
  return ROUTES.map((path) => ({ url: `${origin}${path}` }));
}
