import type { ManagedOpportunity } from "@/lib/types";
import Link from "next/link";
import { UntrustedText } from "./UntrustedText";

/** The shared terminal notice for a merged listing's read and edit routes. */
export function MergedOpportunityBanner({
  mergedInto,
}: {
  mergedInto: NonNullable<ManagedOpportunity["mergedInto"]>;
}) {
  return (
    <aside className="state" aria-label="Merged listing">
      <p className="empty-title">This listing has been merged.</p>
      <p>
        Merged into{" "}
        <Link href={`/opportunities/${encodeURIComponent(mergedInto.id)}`}>
          <UntrustedText value={mergedInto.title} />
        </Link>{" "}
        by a reviewer. This archived record now points to that listing.
      </p>
    </aside>
  );
}
