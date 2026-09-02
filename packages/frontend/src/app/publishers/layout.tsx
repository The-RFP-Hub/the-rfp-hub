import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Publishers" };

export default function PublishersLayout({ children }: { children: ReactNode }) {
  return children;
}
