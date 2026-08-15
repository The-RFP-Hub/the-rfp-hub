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
import { OpportunityForm } from "@/components/OpportunityForm";
import { ResourceView } from "@/components/states";
import { fromDocument } from "@/lib/opportunity-form";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import { useParams } from "next/navigation";
import { useCallback } from "react";

export default function EditListingPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ""));
  return <RequireSession>{() => <EditForm id={id} />}</RequireSession>;
}

function EditForm({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.me.opportunity(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <section>
      <h1>Edit entry</h1>
      <p className="muted footnote">
        A replace re-runs Standard validation and the duplicate check. An edit to an approved entry
        by a publisher who may publish stays approved; otherwise it returns to the review queue —
        the result panel below the form says which happened.
      </p>
      <ResourceView resource={state} what="this entry" onRetry={reload}>
        {(entry) => {
          const { form, carried } = fromDocument(entry);
          return <OpportunityForm mode="edit" initial={form} carried={carried} />;
        }}
      </ResourceView>
    </section>
  );
}
