"use client";

/**
 * The verified publisher directory: every organization a Hub reviewer has verified, and nothing
 * else.
 *
 * NO SESSION IS INVOLVED. `GET /v1/publishers` is unauthenticated — the same route
 * `/organizations/[slug]` already reads for a member's own "verified on" line — and this page never
 * attaches a token, so it renders identically for a stranger and for a signed-in publisher.
 *
 * ONE CALL, NO PAGINATION. The endpoint returns the whole verified set in one page and orders it
 * deterministically by slug (`organization.repository.ts`), which is also why this page does not
 * offer a sort control: there is one order, and it does not depend on when you asked.
 *
 * EVERY STRING ON THIS PAGE THAT A PUBLISHER WROTE — name, description, ecosystems, website — is
 * rendered through `UntrustedText`/`UntrustedLink`, never interpolated into prose or markup. A
 * verified organization is trusted to publish without a second review; it is not trusted to inject
 * HTML into this page, and those are different kinds of trust.
 *
 * `logoUrl` NEVER BECOMES AN `<img>`. This package's CSP is `img-src 'self' data:` for exactly this
 * reason (`src/lib/csp.ts`): loading a remote image would leak every reader's IP address to
 * whatever host a publisher named. The field is shown as a link instead, or omitted.
 */
import { UntrustedLink, UntrustedText } from "@/components/UntrustedText";
import { EmptyState, ResourceView } from "@/components/states";
import { formatInstant } from "@/lib/format";
import { PUBLISHERS_DOC } from "@/lib/links";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { Publisher } from "@/lib/types";
import Link from "next/link";
import { useCallback } from "react";

export default function PublishersPage() {
  const api = useApi();
  const load = useCallback(() => api.publishers.list(), [api]);
  const { state, reload } = useResource(load);

  return (
    <section>
      <h1>Verified publishers</h1>
      <p className="lede">
        Organizations a Hub reviewer has verified. A verified organization decides what publishes in
        its own namespace, without a second review —{" "}
        <Link href="/how-it-works#why">who decides, and why</Link> sets out the whole of it.
      </p>

      <ResourceView resource={state} what="the verified publishers" onRetry={reload}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No organization is verified yet."
              detail="Every listing here still publishes — verification only removes the review wait for an organization's own future submissions."
              action={
                <>
                  <a href={PUBLISHERS_DOC} target="_blank" rel="noopener noreferrer">
                    How to become a verified publisher
                  </a>
                  <Link href="/">Browse the directory</Link>
                </>
              }
            />
          ) : (
            <ul className="plain publisher-grid">
              {data.items.map((publisher) => (
                <li key={publisher.slug}>
                  <PublisherCard publisher={publisher} />
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </section>
  );
}

function PublisherCard({ publisher }: { publisher: Publisher }) {
  const directoryHref = `/?organization=${encodeURIComponent(publisher.slug)}`;
  return (
    // `data-testid`/`data-publisher-slug`: this package otherwise has no test-hook attribute
    // convention (its own tests select by role and text, like the rest of the codebase) — these two
    // exist so an external checker can extract the rendered slug set without depending on prose or
    // markup that is free to change.
    <article
      className="card publisher-card"
      data-testid="publisher-card"
      data-publisher-slug={publisher.slug}
    >
      <h2>
        <UntrustedText value={publisher.name} fallback={publisher.slug} />
      </h2>
      {/*
       * THE NAMESPACE, not just an identifier. `<slug>:` is the prefix every one of this
       * organization's listing ids carries, so showing it here is what lets a reader connect a
       * listing id they already have to the organization that owns it.
       */}
      <p className="muted">
        <code>{publisher.slug}:…</code>
      </p>

      <p className="publisher-description">
        <UntrustedText
          value={publisher.description}
          fallback="This publisher has not written a description."
        />
      </p>

      {publisher.ecosystems.length > 0 ? (
        <ul className="plain chip-list" aria-label="Ecosystems">
          {publisher.ecosystems.map((ecosystem) => (
            <li key={ecosystem} className="chip">
              <UntrustedText value={ecosystem} />
            </li>
          ))}
        </ul>
      ) : null}

      <p>
        <UntrustedLink href={publisher.website} />
      </p>

      {/*
       * NEVER an <img>. `logoUrl` is publisher-supplied and the CSP's `img-src` is `'self' data:`
       * on purpose (see `src/lib/csp.ts`) — loading it would leak every reader's IP to whatever host
       * the publisher named. A labelled link costs nothing and leaks nothing.
       */}
      {publisher.logoUrl ? (
        <p className="muted footnote">
          Logo: <UntrustedLink href={publisher.logoUrl} label="linked, not embedded" />
        </p>
      ) : null}

      <p className="muted footnote">
        {publisher.verifiedAt ? `Verified ${formatInstant(publisher.verifiedAt)}` : "Verified"}
      </p>

      {/*
       * `organization` matches ANY operating OR sponsoring organization on the endpoint
       * (`listQuerySchema`'s own description) — a listing this publisher only sponsors shows up
       * here too, which is correct: the filter is "involves this organization", not "submitted by
       * it".
       */}
      <p>
        <Link href={directoryHref}>View this publisher&rsquo;s listings</Link>
      </p>
    </article>
  );
}
