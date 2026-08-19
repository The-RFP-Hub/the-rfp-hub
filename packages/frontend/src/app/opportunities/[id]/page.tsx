"use client";

/**
 * The public detail page for one published opportunity.
 *
 * Separate from `/listings/[id]`, which is the publisher's workbench view of an entry it may not
 * even be legal to show anybody else — that page reads the owner or reviewer route so that a PENDING
 * entry is visible to the people entitled to it. This one reads the public route, sees only what a
 * stranger sees, and is the read the API counts as a detail view.
 */
import { PublicOpportunity } from "@/components/PublicOpportunity";
import Link from "next/link";
import { useParams } from "next/navigation";

export default function PublicOpportunityPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ""));

  return (
    <>
      <p className="muted">
        <Link href="/">← All opportunities</Link>
      </p>
      <PublicOpportunity id={id} />
    </>
  );
}
