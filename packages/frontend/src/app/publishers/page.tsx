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
import { formatCount, formatInstant } from "@/lib/format";
import { PUBLISHERS_DOC } from "@/lib/links";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { OpportunitySummary, Publisher } from "@/lib/types";
import Link from "next/link";
import { useCallback } from "react";

export default function PublishersPage() {
  const api = useApi();
  const load = useCallback(() => api.publishers.list(), [api]);
  const { state, reload } = useResource(load);
  const loadListed = useCallback(async () => {
    const items: OpportunitySummary[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await api.directory.list({ status: "open", page, limit: 100 });
      items.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return items;
  }, [api]);
  const listed = useResource(loadListed);

  return (
    <section>
      <h1>Publishers</h1>
      <p className="lede">
        Every organization with an open listing on the index. A <strong>verified</strong> one
        publishes to its own namespace without a second review; a <strong>listed</strong> one was
        indexed from public sources and has not claimed its listings yet.
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
                  <Link href="/directory">Browse the directory</Link>
                </>
              }
            />
          ) : (
            <>
              <h2>Verified</h2>
              <ul className="plain publisher-grid">
                {data.items.map((publisher) => (
                  <li key={publisher.slug}>
                    <PublisherCard publisher={publisher} />
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </ResourceView>

      <ResourceView resource={listed.state} what="the listed organizations" onRetry={listed.reload}>
        {(items) => (
          <ListedOrganizations
            items={items}
            verified={new Set(state.status === "ready" ? state.data.items.map((p) => p.slug) : [])}
          />
        )}
      </ResourceView>

      <p className="card">
        <strong>Run one of these?</strong> Open your listing in the directory and claim it, or{" "}
        <a href={PUBLISHERS_DOC} target="_blank" rel="noopener noreferrer">
          read how verification works
        </a>
        . A reviewer grants it.
      </p>
    </section>
  );
}

/**
 * The organizations behind the open set, grouped by operating organization. Not a claim of
 * endorsement, and the badge says which ones have claimed their namespace.
 */
function ListedOrganizations({
  items,
  verified,
}: {
  items: OpportunitySummary[];
  verified: Set<string>;
}) {
  const groups = new Map<string, { name: string; count: number }>();
  for (const item of items) {
    const org = item.operatingOrganizations[0];
    if (!org) continue;
    const current = groups.get(org.slug) ?? { name: org.name, count: 0 };
    current.count += 1;
    groups.set(org.slug, current);
  }
  const rows = [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name),
  );
  if (rows.length === 0) return null;
  return (
    <>
      <h2>Listed</h2>
      <p className="org-legend">
        <span>{formatCount(rows.length)} organizations with an open listing</span>
        <span>ranked by open listings</span>
      </p>
      <ul className="plain org-grid">
        {rows.map(([slug, org]) => (
          <li key={slug}>
            <Link
              className={`org-card${verified.has(slug) ? " is-verified" : ""}`}
              href={`/directory?organization=${encodeURIComponent(slug)}`}
            >
              <span className="org-mark" aria-hidden="true">
                {initials(org.name)}
              </span>
              <span>
                <span className="org-card-name">
                  <UntrustedText value={org.name} fallback={slug} />
                </span>
                <span className="org-card-note">
                  {formatCount(org.count)} open listing{org.count === 1 ? "" : "s"}
                </span>
              </span>
              <span className="org-card-state">{verified.has(slug) ? "verified" : "listed"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [first = "", second = ""] = words;
  if (first === "") return "?";
  if (second === "") return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function PublisherCard({ publisher }: { publisher: Publisher }) {
  const directoryHref = `/directory?organization=${encodeURIComponent(publisher.slug)}`;
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
