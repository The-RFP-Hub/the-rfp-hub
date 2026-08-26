import type { Metadata } from "next";
import type { ReactNode } from "react";

interface OpportunityLayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: Pick<OpportunityLayoutProps, "params">): Promise<Metadata> {
  const { id } = await params;
  return { title: id };
}

export default function OpportunityLayout({ children }: OpportunityLayoutProps) {
  return children;
}
