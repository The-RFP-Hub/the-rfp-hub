import { canonicalSiteOrigin, isCanonicalRequest } from "@/lib/site-origin";
import type { MetadataRoute } from "next";

/**
 * Allow everything — but ONLY on the declared canonical origin. Every other host this app answers
 * on (staging, a Vercel preview, a self-hosted copy that has not set `NEXT_PUBLIC_SITE_ORIGIN`)
 * gets a blanket `Disallow: /`, because indexing a duplicate of the real site is worse than a
 * crawler finding nothing at all — search engines penalise exactly that kind of duplicate content,
 * and a preview URL that ranked would compete with the real one for every listing it carries.
 *
 * There is otherwise nothing here worth carving an exception for on the canonical host itself: the
 * workbench routes need a session and render an empty shell without one (see `sitemap.ts`), so a
 * crawler that reaches one finds nothing to index rather than something that needed hiding.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!(await isCanonicalRequest())) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const origin = canonicalSiteOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
