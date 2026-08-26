import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Review queues" };

export default function ReviewLayout({ children }: { children: ReactNode }) {
  return children;
}
