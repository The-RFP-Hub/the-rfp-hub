"use client";

/**
 * "You're leaving RFPSear.ch": the page between a listing's counted link-out and a destination
 * this site will not send a reader to silently.
 *
 * WHO SENDS READERS HERE. The API's `/v1/r/{id}/apply` and `/v1/r/{id}/source` redirects, and
 * nothing else on this site. For a link nobody has reviewed, a programme that has closed, or a link
 * that started landing somewhere new, the API answers with a 302 to
 * `/leaving/{id}?link=apply|source&reason=…` instead of to the stored URL. Until that API change
 * ships nothing links here at all, and the page still has to stand on its own when somebody opens
 * it by hand: it reads the listing, shows the link, and lets them on.
 *
 * THE DESTINATION COMES FROM THE LISTING, NEVER FROM THE ADDRESS BAR. The query names which of the
 * listing's two links and why — `lib/leaving.ts` reads those two parameters and nothing else — and
 * the URL behind "Continue" is the stored `applicationUrl` or `website`, read by id through the
 * public route. A forged query can choose between two links the listing already publishes; it
 * cannot put an address of its own on this page.
 *
 * THE NOTICE STATES ONLY WHAT THE LISTING SAYS. The query's `reason` is parsed and never shown as a
 * fact: anyone can write `?reason=closed` on an open listing, and the page must not announce a
 * closure on this site's behalf on the strength of the address bar. "This program is closed" comes
 * from the listing's own `status` (`noticeCopy` in `lib/leaving.ts`); every other case gets the
 * plain security notice, which is true of every link.
 *
 * WHAT THE READER SEES IS WHAT THE PARSER SAYS. The host shown large, and named in the button, is
 * `new URL(stored).host` (see `linkHost`), so `https://airtable.com@evil.example/` reads
 * `evil.example` here; the full URL sits under it as plain text for anybody who wants the path too.
 * Both are `UntrustedText`: a publisher wrote them.
 *
 * NOTHING HERE LOADS FROM THE DESTINATION. Plain anchors and text only — no favicon, no preview, no
 * prefetch — so `lib/csp.ts` stays exactly as strict as it is and the destination learns nothing
 * about a reader who decides not to go. "Continue" carries `noreferrer` for the same reason: the
 * page a reader came from is not the destination's business, and `nofollow` because a link this
 * page exists to hedge is not one this site vouches for to a crawler either.
 */
import { IconLabel } from "@/components/IconLabel";
import { UntrustedText } from "@/components/UntrustedText";
import { ErrorState, Loading } from "@/components/states";
import type { ApiError } from "@/lib/api";
import {
  LINK_WORDS,
  type LeavingLink,
  leavingDestination,
  noticeCopy,
  readLeavingQuery,
} from "@/lib/leaving";
import { DIRECTORY } from "@/lib/links";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import { linkHost } from "@/lib/url-policy";
import { ArrowLeftIcon, ArrowRightIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback } from "react";

const WHAT = "where this link goes";

function listingPath(id: string): string {
  return `/opportunities/${encodeURIComponent(id)}`;
}

/** The way back, offered in every state including the ones that cannot offer the way on. */
function BackToListing({ id }: { id: string }) {
  return (
    <Link href={listingPath(id)}>
      <IconLabel icon={ArrowLeftIcon}>Back to the listing</IconLabel>
    </Link>
  );
}

export function LeavingNotice({ id }: { id: string }) {
  const api = useApi();
  const { link } = readLeavingQuery(useSearchParams());
  // NOT A DETAIL VIEW. The redirect that sent this reader here already counted their apply or
  // source click; counting this read as well would credit the listing twice for one action.
  const load = useCallback(() => api.directory.find(id, { count: false }), [api, id]);
  const { state, reload } = useResource(load);

  if (state.status === "idle" || state.status === "loading") {
    return (
      <section className="leaving" aria-labelledby="leaving-heading">
        <h1 id="leaving-heading">You&rsquo;re leaving RFPSear.ch</h1>
        <Loading what={WHAT} />
      </section>
    );
  }

  if (state.status === "error") {
    if (isGone(state.error)) return <LinkUnavailable id={id} link={link} listingFound={false} />;
    // Anything else — the API unreachable, rate-limited, timing out — is not an answer about the
    // link, so it is not reported as one. The reader gets the ordinary failure state with its retry,
    // and the way back; there is no destination to offer, because the only place it may come from
    // is the read that just failed.
    return (
      <section className="leaving" aria-labelledby="leaving-heading">
        <h1 id="leaving-heading">You&rsquo;re leaving RFPSear.ch</h1>
        <ErrorState error={state.error} what={WHAT} onRetry={reload} />
        <p className="row leaving-actions">
          <BackToListing id={id} />
        </p>
      </section>
    );
  }

  const entry = state.data;
  const destination = leavingDestination(entry, link);
  const host = destination ? linkHost(destination) : null;
  // `entry.id`, not the route's: the public read resolves an alias to its canonical id, and the way
  // back should land on the listing's own address.
  if (!destination || !host) {
    return <LinkUnavailable id={entry.id} link={link} listingFound title={entry.title} />;
  }

  return (
    <section className="leaving" aria-labelledby="leaving-heading">
      <h1 id="leaving-heading">You&rsquo;re leaving RFPSear.ch</h1>
      <p className="lede">
        {LINK_WORDS[link].definite} on{" "}
        <Link href={listingPath(entry.id)}>
          <UntrustedText value={entry.title} fallback={entry.id} />
        </Link>{" "}
        goes to a site RFPSear.ch doesn&rsquo;t run.
      </p>

      <dl className="leaving-destination">
        <dt>Where it goes</dt>
        <dd className="leaving-host">
          <UntrustedText value={host} />
        </dd>
        <dt>Full address</dt>
        <dd className="leaving-url">
          <UntrustedText value={destination} />
        </dd>
      </dl>

      <div className="callout leaving-reason">
        <p className="empty-title">
          <IconLabel icon={ExclamationTriangleIcon}>Security notice</IconLabel>
        </p>
        <p>{noticeCopy(entry)}</p>
      </div>

      <p className="row leaving-actions">
        {/*
         * SAME TAB. The apply button already opened this page in a tab of its own; a second one
         * here would leave the reader with an orphaned "leaving" tab behind every application.
         */}
        <a className="button-primary" href={destination} rel="noopener noreferrer nofollow">
          <IconLabel icon={ArrowRightIcon} position="end">
            Continue to <UntrustedText value={host} />
          </IconLabel>
        </a>
        <BackToListing id={entry.id} />
      </p>
      <p className="muted footnote">
        RFPSear.ch lists programs and takes no applications. Check the address above before you sign
        in, pay, or share anything there.
      </p>
    </section>
  );
}

/** 404, or a merged listing: either way there is no published listing behind this id any more. */
function isGone(error: ApiError): boolean {
  return error.isNotFound || error.code === "opportunity_merged";
}

/**
 * The state that withholds "Continue", and says why in terms the reader can act on.
 *
 * Three different causes land here — no published listing, a listing with no such link, a stored
 * value that is not an `https://` URL — and none of them is the reader's doing, so none of them is
 * worded as an error. The stored value is deliberately NOT shown in the last case: printing a
 * `javascript:` string under a heading about where a link goes is an invitation to paste it.
 */
function LinkUnavailable({
  id,
  link,
  listingFound,
  title,
}: {
  id: string;
  link: LeavingLink;
  listingFound: boolean;
  title?: string;
}) {
  return (
    <section className="leaving" aria-labelledby="leaving-heading">
      <h1 id="leaving-heading">This link isn&rsquo;t available</h1>
      {listingFound ? (
        <p className="lede">
          <Link href={listingPath(id)}>
            <UntrustedText value={title} fallback={id} />
          </Link>{" "}
          doesn&rsquo;t carry {LINK_WORDS[link].indefinite} RFPSear.ch can send you to.
        </p>
      ) : (
        <p className="lede">
          There is no published listing at this address any more, so there is no link to follow.
        </p>
      )}
      <p className="row leaving-actions">
        <BackToListing id={id} />
        {listingFound ? null : <Link href={DIRECTORY}>Search the directory</Link>}
      </p>
    </section>
  );
}
