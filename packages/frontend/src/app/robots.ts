import { requestOrigin } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * Allow everything. There is nothing here worth carving an exception for: the workbench routes need
 * a session and render an empty shell without one (see `sitemap.ts`), so a crawler that reaches one
 * finds nothing to index rather than something that needed hiding.
 *
 * The sitemap reference is only emitted when the origin can be resolved from the request — an
 * absolute URL a crawler cannot resolve is worse than none, matching `sitemap.ts`'s own fallback.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await requestOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
