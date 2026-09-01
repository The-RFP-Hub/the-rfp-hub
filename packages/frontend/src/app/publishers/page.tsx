"use client";

/**
 * The verified publisher directory. No session, no token: `GET /v1/publishers` is unauthenticated and
 * returns the whole set in one deterministic order, hence no pagination and no sort control.
 *
 * Every string a publisher wrote goes through `UntrustedText`/`UntrustedLink` — a verified
 * organization is trusted to publish without a second review, not to inject HTML here — and
 * `logoUrl` NEVER becomes an `<img>`: the CSP never allows a publisher-named host in `img-src`
 * (`src/lib/csp.ts`), because loading it would leak every reader's IP to whatever host it named.
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
  const name = publisher.name.trim() || publisher.slug;
  return (
    // The two data attributes are this package's only test hooks: an external checker reads the
    // rendered slug set from them rather than from prose that is free to change.
    <article
      className="card publisher-card"
      data-testid="publisher-card"
      data-publisher-slug={publisher.slug}
    >
      <h2>
        <UntrustedText value={publisher.name} fallback={publisher.slug} />
      </h2>
      {/* The namespace, not just an identifier: `<slug>:` prefixes every listing id this
          organization owns. Labeled, because a bare `filecoin:…` announces as nothing. */}
      <p className="muted">
        <span className="visually-hidden">Namespace: </span>
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

      {publisher.logoUrl ? (
        <p className="muted footnote">
          Logo:{" "}
          <UntrustedLink
            href={publisher.logoUrl}
            label="linked, not embedded"
            ariaLabel={`${name} logo: linked, not embedded`}
          />
        </p>
      ) : null}

      <p className="muted footnote">
        {publisher.verifiedAt ? `Verified ${formatInstant(publisher.verifiedAt)}` : "Verified"}
      </p>

      <p>
        <Link href={directoryHref}>View this publisher&rsquo;s listings</Link>
      </p>
      {/* `organization` matches the operating OR the sponsoring organization, and the reader has
          to be told which before they click. */}
      <p className="muted footnote">Every listing this organization operates or sponsors.</p>
    </article>
  );
}
