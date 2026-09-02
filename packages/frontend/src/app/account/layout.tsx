import { NOINDEX_ROBOTS } from "@/lib/noindex-routes";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Account", robots: NOINDEX_ROBOTS };

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
