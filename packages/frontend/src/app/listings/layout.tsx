import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "Your listings",
    template: "%s | RFP Hub",
  },
};

export default function ListingsLayout({ children }: { children: ReactNode }) {
  return children;
}
