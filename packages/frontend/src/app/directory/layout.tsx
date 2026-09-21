import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Directory",
  description:
    "Grants, hackathons, bounties and RFPs that are open right now across Ethereum, with award, organization and closing date. Apply on the program's own site.",
};

export default function DirectoryLayout({ children }: { children: ReactNode }) {
  return children;
}
