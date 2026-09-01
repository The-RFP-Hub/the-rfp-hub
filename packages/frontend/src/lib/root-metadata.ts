/**
 * The root layout's `generateMetadata`, in its own module: importing `src/app/layout.tsx` in a unit
 * test pulls in `next/font/google`, which throws under Vitest before an assertion runs.
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
