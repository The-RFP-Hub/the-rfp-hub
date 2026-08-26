import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "Organizations",
    template: "%s | RFP Hub",
  },
};

export default function OrganizationsLayout({ children }: { children: ReactNode }) {
  return children;
}
