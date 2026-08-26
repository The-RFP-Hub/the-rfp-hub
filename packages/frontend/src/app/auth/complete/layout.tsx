import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Complete sign-in" };

export default function AuthCompleteLayout({ children }: { children: ReactNode }) {
  return children;
}
