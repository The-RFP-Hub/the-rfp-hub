import { NOINDEX_ROBOTS } from "@/lib/noindex-routes";
import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * NOINDEX, AND OUT OF THE SITEMAP. This page is a step between a listing and somebody else's site,
 * reached through the API's link-out redirect: it has nothing a searcher should land on, and one
 * indexed copy per listing per link would be thousands of near-identical pages competing with the
 * listings themselves. `/leaving` is in `NOINDEX_ROUTE_PREFIXES` too, so `robots.txt` disallows it
 * for a crawler that ignores the meta tag.
 *
 * A static title, not the listing's: the server pass has no business fetching a record only to
 * name a page whose whole content is client-read, and "You're leaving" is what the tab should say.
 */
export const metadata: Metadata = { title: "You’re leaving", robots: NOINDEX_ROBOTS };

export default function LeavingLayout({ children }: { children: ReactNode }) {
  return children;
}
