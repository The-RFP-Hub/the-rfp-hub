import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Account" };

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
