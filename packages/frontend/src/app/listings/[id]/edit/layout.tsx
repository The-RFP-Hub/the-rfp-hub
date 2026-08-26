import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Edit listing" };

export default function EditListingLayout({ children }: { children: ReactNode }) {
  return children;
}
