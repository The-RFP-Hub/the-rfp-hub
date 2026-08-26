import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Terms" };

export default function TermsLayout({ children }: { children: ReactNode }) {
  return children;
}
