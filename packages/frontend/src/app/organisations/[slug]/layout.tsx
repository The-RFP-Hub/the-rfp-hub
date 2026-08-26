import type { Metadata } from "next";
import type { ReactNode } from "react";

interface OrganisationLayoutProps {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: Pick<OrganisationLayoutProps, "params">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Organisation ${slug}` };
}

export default function OrganisationLayout({ children }: OrganisationLayoutProps) {
  return children;
}
