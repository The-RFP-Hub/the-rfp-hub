import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Directory" };

export default function DirectoryLayout({ children }: { children: ReactNode }) {
  return children;
}
