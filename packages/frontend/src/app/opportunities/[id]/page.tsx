"use client";

import { IconLabel } from "@/components/IconLabel";
/**
 * The public detail page for one published opportunity.
 *
 * Separate from `/listings/[id]`, which is the publisher's workbench view of a listing it may not
 * even be legal to show anybody else — that page reads the owner or reviewer route so that a PENDING
 * submission is visible to the people entitled to it. This one reads the public route, sees only
 * what a stranger sees, and is the read the API counts as a detail view.
 *
 * THE WAY BACK KEEPS THE READER'S FILTERS. `router.back()` rather than a link to `/`, because the
 * directory now holds its filters in the address bar: a reader who searched, narrowed to open
 * grants and opened the third result wants that page back, not a fresh one. The plain link stays
 * beside it for the case that has no history to go back to — a listing opened from a shared link,
 * where "back" would leave the site altogether.
 */
import { PublicOpportunity } from "@/components/PublicOpportunity";
import { ReturnLink, useHasReturnLink } from "@/components/ReturnLink";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

export default function PublicOpportunityPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(String(params.id ?? ""));
  /*
   * A NAMED ORIGIN WINS OVER THE GENERIC PAIR. Arriving from a review surface, the reader was told
   * exactly where they came from and that is where "back" should go; showing the directory's own
   * "back to your search" underneath it would offer two different answers to one question.
   */
  const fromElsewhere = useHasReturnLink();

  return (
    <>
      {fromElsewhere ? (
        <ReturnLink />
      ) : (
        <p className="row muted">
          <button type="button" onClick={() => router.back()}>
            <IconLabel icon={ArrowLeftIcon}>Back to your search</IconLabel>
          </button>
          <Link href="/">All opportunities</Link>
        </p>
      )}
      <PublicOpportunity id={id} />
    </>
  );
}
