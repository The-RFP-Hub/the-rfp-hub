import type { Metadata } from "next";
import type { ReactNode } from "react";

interface ListingLayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: Pick<ListingLayoutProps, "params">): Promise<Metadata> {
  const { id } = await params;
  return {
    title: {
      default: id,
      template: "%s | RFP Hub",
    },
  };
}

export default function ListingLayout({ children }: ListingLayoutProps) {
  return children;
}
