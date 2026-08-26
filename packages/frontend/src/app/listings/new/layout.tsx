import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Submit an opportunity" };

export default function NewListingLayout({ children }: { children: ReactNode }) {
  return children;
}
