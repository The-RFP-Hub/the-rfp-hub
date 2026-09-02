import { NOINDEX_ROBOTS } from "@/lib/noindex-routes";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Complete sign-in", robots: NOINDEX_ROBOTS };

export default function AuthCompleteLayout({ children }: { children: ReactNode }) {
  return children;
}
