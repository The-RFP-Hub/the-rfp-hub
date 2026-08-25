"use client";

/**
 * A new submission.
 *
 * The page says up front what happens to it, because "submit" means two different things depending
 * on the account: a member of a verified organisation publishes immediately, everybody else files
 * something a reviewer will look at. A form that implies the first to somebody in the second case
 * has misled them about whether their programme is visible.
 */
import { RequireSession } from "@/components/Chrome";
import { OpportunityForm } from "@/components/OpportunityForm";
import { emptyForm } from "@/lib/opportunity-form";

export default function NewListingPage() {
  return (
    <RequireSession>
      {(me) => {
        const verified = me.memberships.filter((membership) => membership.verified);
        return (
          <section>
            <h1>Submit an opportunity</h1>
            {verified.length > 0 ? (
              <p className="muted footnote">
                This account publishes into{" "}
                {verified.map((membership) => membership.slug).join(", ")} without review. An id
                with one of those organisation prefixes publishes immediately; anything else waits
                for review.
              </p>
            ) : (
              <p className="muted footnote">
                This account is not a member of a verified organisation, so this submission will be
                stored <strong>waiting for review</strong> and stay hidden from the public directory
                until a Hub reviewer approves it. That is the normal path for a community
                submission.
              </p>
            )}
            <OpportunityForm
              mode="create"
              accountId={me.accountId}
              initial={emptyForm()}
              // What the API is going to decide, handed to the form so the id field can say it
              // live rather than after a round trip.
              authority={{
                verifiedNamespaces: verified.map((membership) => membership.slug),
                directCreate: me.directCreate,
              }}
            />
          </section>
        );
      }}
    </RequireSession>
  );
}
