"use client";

/**
 * The organisations this account belongs to.
 *
 * IT EXISTS FOR THE NAVIGATION, and only secondarily as a page. An account with one membership gets
 * a link straight to that organisation in the header — a landing page listing exactly one row would
 * be a click that answers nothing. An account with several needs somewhere to choose, and this is
 * it; an account with none still needs the address to resolve, because the header link disappears
 * the moment a membership is revoked and a bookmark should not 404 into nothing.
 *
 * The whole page is rendered from `GET /v1/me`. Nothing is fetched: memberships arrive with the
 * session, and asking again for something already in hand would be slower and no more true.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { VerifiedBadge } from "@/components/badges";
import { EmptyState } from "@/components/states";
import { HOW_IT_WORKS } from "@/lib/links";
import type { Me } from "@/lib/types";
import Link from "next/link";

export default function OrganisationsPage() {
  return <RequireSession>{(me) => <Organisations me={me} />}</RequireSession>;
}

function Organisations({ me }: { me: Me }) {
  return (
    <section>
      <h1>Your organisations</h1>
      {me.memberships.length === 0 ? (
        <EmptyState
          title="You are not a member of any organisation."
          detail="Submissions from this account land pending, which is the normal path for a community submission. Claiming a listing for an organisation you run is how that changes — a reviewer grants the membership."
          action={
            <>
              <Link className="button-primary" href="/listings">
                Your listings
              </Link>
              <Link href={HOW_IT_WORKS}>How publishing rights work</Link>
            </>
          }
        />
      ) : (
        <>
          <p className="lede">
            What each of these lets you do depends on whether it is verified — that is a
            reviewer&rsquo;s decision, and it is what decides whether your listings publish
            immediately or wait.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Your role</th>
                  <th scope="col">Publishing</th>
                </tr>
              </thead>
              <tbody>
                {me.memberships.map((membership) => (
                  <tr key={membership.slug}>
                    <th scope="row">
                      <Link
                        className="row-title"
                        href={`/organisations/${encodeURIComponent(membership.slug)}`}
                      >
                        <UntrustedText value={membership.name} />
                      </Link>
                      <div className="muted">
                        <code>{membership.slug}</code>
                      </div>
                    </th>
                    <td>{membership.role}</td>
                    <td>
                      <VerifiedBadge verified={membership.verified} gloss />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
