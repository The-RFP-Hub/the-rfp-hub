import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "Organisations",
    template: "%s | RFP Hub",
  },
};

export default function OrganisationsLayout({ children }: { children: ReactNode }) {
  return children;
}
