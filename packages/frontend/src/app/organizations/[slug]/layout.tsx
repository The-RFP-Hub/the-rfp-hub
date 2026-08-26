import type { Metadata } from "next";
import type { ReactNode } from "react";

interface OrganizationLayoutProps {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: Pick<OrganizationLayoutProps, "params">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Organization ${slug}` };
}

export default function OrganizationLayout({ children }: OrganizationLayoutProps) {
  return children;
}
