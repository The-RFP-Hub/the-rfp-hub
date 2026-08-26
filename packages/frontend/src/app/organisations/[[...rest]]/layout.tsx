import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Organizations",
};

export default function LegacyOrganizationsLayout({ children }: { children: ReactNode }) {
  return children;
}
