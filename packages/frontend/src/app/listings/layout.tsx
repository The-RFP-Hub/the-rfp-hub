import { NOINDEX_ROBOTS } from "@/lib/noindex-routes";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "Your listings",
    template: "%s | RFP Hub",
  },
  robots: NOINDEX_ROBOTS,
};

export default function ListingsLayout({ children }: { children: ReactNode }) {
  return children;
}
