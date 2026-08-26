import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Organisations" };

export default function OrganisationsLayout({ children }: { children: ReactNode }) {
  return children;
}
