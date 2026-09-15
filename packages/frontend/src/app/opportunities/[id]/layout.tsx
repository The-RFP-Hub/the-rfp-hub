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
  const image = `${origin}/opportunities/${encodeURIComponent(id)}/card.png`;
  return {
    title: id,
    openGraph: { images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default function OpportunityLayout({ children }: OpportunityLayoutProps) {
  return children;
}
