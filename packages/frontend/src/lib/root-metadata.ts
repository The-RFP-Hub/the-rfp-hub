/**
 * The root layout's `generateMetadata`, pulled out of `src/app/layout.tsx` so it is importable
 * without also importing `next/font/google` (via `lib/fonts.ts`) and the whole provider tree —
 * neither of which this function touches, and the font loader in particular has no transform under
 * the package's own test runner (Vitest, not a Next build), so importing the layout module directly
 * in a unit test throws before a single assertion runs.
 *
 * `robots` IS THE ONE FIELD HERE THAT CANNOT BE A BUILD-TIME CONSTANT any more — see
 * `lib/site-origin.ts` for the full reasoning. Everything else is exactly what it was when this was
 * a static `metadata` object.
 */
import { isCanonicalRequest } from "@/lib/site-origin";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const canonical = await isCanonicalRequest();
  return {
    title: {
      default: "Directory | RFP Hub",
      template: "%s | RFP Hub",
    },
    description:
      "An open index of funding opportunities under one standard: read it without an account, and — for publishers — submit and maintain listings, read their traffic, and run the review queues.",
    robots: { index: canonical, follow: canonical },
  };
}
