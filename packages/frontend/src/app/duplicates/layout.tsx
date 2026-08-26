import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Duplicate matches" };

export default function DuplicatesLayout({ children }: { children: ReactNode }) {
  return children;
}
