import { createApiClient } from "@/lib/api";
import { readConfig } from "@/lib/config";
import { requestOrigin } from "@/lib/site-origin";
import type { Metadata } from "next";
import type { ReactNode } from "react";

interface OpportunityLayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

/**
 * The share card image is served at this listing's own `/card.png`, so `openGraph`/`twitter` point
 * there instead of at a generic site image. `requestOrigin()` — the same header-derived origin
 * `card.png` itself uses — is skipped only when this request carries no `Host` at all (a unit test
 * calling this function directly, outside a request); a real request always has one.
 */
export async function generateMetadata({
  params,
}: Pick<OpportunityLayoutProps, "params">): Promise<Metadata> {
  const { id } = await params;
  const origin = await requestOrigin();
  if (!origin) return { title: id };

  // The listing's own title and summary, when the API answers: a link preview and a search result
  // should read like the listing, not like its join key. Anything else falls back to the id, which
  // the client then replaces once the page loads.
  let title = id;
  let description: string | undefined;
  const config = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
  if (config.ok) {
    try {
      const entry = await createApiClient({ baseUrl: config.config.apiBaseUrl }).directory.find(id);
      title = entry.title.trim() || id;
      const text = (entry.summary?.trim() || entry.description || "").replace(/\s+/g, " ").trim();
      if (text) description = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    } catch {
      // Not published, or the API is unreachable: the id is still a truthful title.
    }
  }

  const image = `${origin}/opportunities/${encodeURIComponent(id)}/card.png`;
  return {
    title,
    ...(description ? { description } : {}),
    openGraph: {
      ...(description ? { title, description } : {}),
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default function OpportunityLayout({ children }: OpportunityLayoutProps) {
  return children;
}
