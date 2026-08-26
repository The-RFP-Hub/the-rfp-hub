"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";

interface LegacyOrganizationsRedirectProps {
  params: Promise<{ rest?: string[] }>;
}

export function legacyOrganizationDestination(rest: string[] = []): string {
  const suffix = rest.map((segment) => encodeURIComponent(segment)).join("/");
  return suffix === "" ? "/organizations" : `/organizations/${suffix}`;
}

export default function LegacyOrganizationsRedirect({ params }: LegacyOrganizationsRedirectProps) {
  const { rest } = use(params);
  const router = useRouter();
  const destination = legacyOrganizationDestination(rest);

  useEffect(() => {
    router.replace(`${destination}${window.location.search}${window.location.hash}`);
  }, [destination, router]);

  return null;
}
