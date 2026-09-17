/**
 * The root layout's `generateMetadata`, in its own module: importing `src/app/layout.tsx` in a unit
 * test pulls in `next/font/google`, which throws under Vitest before an assertion runs.
 */
import { isCanonicalRequest, requestOrigin } from "@/lib/site-origin";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const canonical = await isCanonicalRequest();
  const origin = await requestOrigin();
  const image = origin ? `${origin}/card.png` : null;
  return {
    ...(image
      ? {
          openGraph: { images: [{ url: image, width: 1200, height: 630 }] },
          twitter: { card: "summary_large_image" as const, images: [image] },
        }
      : {}),
    title: {
      default: "RFP Hub: an open index of Ethereum funding",
      template: "%s | RFP Hub",
    },
    description:
      "An open index of funding opportunities under one standard. Read it without an account. Publishers can sign in to submit and maintain listings, check their traffic, and run their review queues.",
    robots: { index: canonical, follow: canonical },
  };
}
