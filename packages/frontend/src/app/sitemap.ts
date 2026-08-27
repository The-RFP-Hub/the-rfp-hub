import { requestOrigin } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * The whole public sitemap, as five static paths.
 *
 * NOT THE OPPORTUNITIES. `GET /v1/opportunities` is unauthenticated and paginated, and every
 * listing already gets a per-entry `<url>` would mean fetching the whole directory on every crawl
 * of `/sitemap.xml` — a network call and a pagination loop this file does not need in order to be
 * correct. The five routes below are the whole of the app's STATIC surface: everything an anonymous
 * visitor can reach without picking a specific entry, which is exactly what a search engine needs
 * in order to find the directory and start crawling it on its own.
 *
 * The workbench routes (`/dashboard`, `/listings`, `/keys`, `/review`, `/admin`, …) are deliberately
 * absent: every one of them needs a session to show anything, so a crawler visiting one gets an
 * empty shell — the client-fetched content this package's README already names as a known gap.
 */
const ROUTES = ["/", "/how-it-works", "/publishers", "/privacy", "/terms"] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await requestOrigin();
  if (!origin) return [];
  return ROUTES.map((path) => ({ url: `${origin}${path}`, lastModified: new Date() }));
}
