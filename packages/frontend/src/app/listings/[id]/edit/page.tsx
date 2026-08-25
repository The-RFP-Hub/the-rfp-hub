"use client";

/**
 * Editing an entry, which the API models as a REPLACE.
 *
 * That matters here more than anywhere else in the dashboard: `PUT` overwrites the stored record,
 * so the form loads the current document first and carries every field it does not itself render
 * through untouched (`fromDocument` → `carried`). Building a fresh document from the visible inputs
 * would silently delete milestones, social links and prizes that a publisher entered elsewhere.
 */
import { RequireSession } from "@/components/Chrome";
import { MergedOpportunityBanner } from "@/components/MergedOpportunityBanner";
import { OpportunityForm } from "@/components/OpportunityForm";
import { ResourceView } from "@/components/states";
import { loadManagedOpportunity, loadOpportunity } from "@/lib/api";
import { fromDocument } from "@/lib/opportunity-form";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { Me } from "@/lib/types";
import { useParams } from "next/navigation";
import { useCallback } from "react";

export default function EditListingPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ""));
  return <RequireSession>{(me) => <EditForm id={id} me={me} />}</RequireSession>;
}

function EditForm({ id, me }: { id: string; me: Me }) {
  const api = useApi();
  // The same two-route read the detail page does, for the same reason: a reviewer may edit an
  // entry (submitter, namespace member or T3+ may `PUT`), and the owner route 404s one that is
  // not theirs.
  const load = useCallback(() => loadOpportunity(api, id, me.canReview), [api, id, me.canReview]);
  const loadWithMetadata = useCallback(async () => {
    const [entry, managed] = await Promise.all([
      load(),
      loadManagedOpportunity(api, id, me.canReview),
    ]);
    return { entry, managed };
  }, [api, id, load, me.canReview]);
  const { state, reload } = useResource(loadWithMetadata);

  return (
    <section>
      <ResourceView resource={state} what="this listing" onRetry={reload}>
        {({ entry, managed }) => {
          if (managed.mergedInto) {
            return (
              <>
                <h1>Archived listing</h1>
                <MergedOpportunityBanner mergedInto={managed.mergedInto} />
              </>
            );
          }
          const { form, carried } = fromDocument(entry);
          return (
            <>
              <h1>Edit this listing</h1>
              <p className="muted footnote">
                A replace re-runs Standard validation and the duplicate check. An edit to a
                published listing by a publisher who may publish stays approved; otherwise it
                returns to the review queue — the result panel below the form says which happened.
              </p>
              <OpportunityForm
                mode="edit"
                initial={form}
                carried={carried}
                authority={{
                  verifiedNamespaces: me.memberships
                    .filter((membership) => membership.verified)
                    .map((membership) => membership.slug),
                  directCreate: me.directCreate,
                }}
              />
            </>
          );
        }}
      </ResourceView>
    </section>
  );
}
