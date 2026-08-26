import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "API keys" };

export default function KeysLayout({ children }: { children: ReactNode }) {
  return children;
}
