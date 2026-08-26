import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "How it works" };

export default function HowItWorksLayout({ children }: { children: ReactNode }) {
  return children;
}
