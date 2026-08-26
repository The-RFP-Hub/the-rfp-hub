import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Your listings" };

export default function ListingsLayout({ children }: { children: ReactNode }) {
  return children;
}
