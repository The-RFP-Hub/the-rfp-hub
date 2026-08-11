/**
 * PURE mapping and rendering for the syndication feeds — no Fastify, no DB, fully unit-testable.
 *
 * `toFeedEntry` projects a Standard opportunity onto the handful of fields a feed reader can show;
 * `renderAtomFeed` / `renderRssFeed` turn a list of those into an Atom 1.0 (RFC 4287) or RSS 2.0
 * document. Every string reaches the document through `shared/xml.ts`, which escapes by
 * construction — there is no code path here that concatenates a record field into markup.
 *
 * ## Identifiers, and what happens when `PUBLIC_BASE_URL` is not configured
 *
 * `atom:id` (and the RSS `guid`) is the ONE field a reader uses to decide whether it has seen an
 * entry before, so it has to be stable for the life of the record. It is derived from the record's
 * own public id, in one of two forms:
 *
 * - `PUBLIC_BASE_URL` configured (every deployment) → the record's own API URL,
 *   `<base>/v1/opportunities/<id>`, which is both an identifier and something a human can open;
 * - `PUBLIC_BASE_URL` unset, i.e. the relative `/` default → `urn:rfphub:opportunity:<id>`. The
 *   base URL is the API's published identity and this API deliberately never derives it from the
 *   request's `Host` header (see `config.ts`), so with nothing configured there is no absolute URL
 *   to mint and a URN is the honest fallback: still an absolute IRI, still stable, just not
 *   dereferenceable. Entry LINKS degrade the same way, to a site-relative path.
 *
 * That fallback exists for local development. Moving between the two forms CHANGES entry identity
 * — every subscriber would see the whole feed as new once — so a deployment must set
 * `PUBLIC_BASE_URL` before it publishes a feed URL to anyone, and must not change it afterwards.
 * Nothing about the scheme changes when the canonical domain lands: the ids are the API's own
 * `/v1/opportunities/{id}` URLs under whatever `PUBLIC_BASE_URL` names, and the apex is the
 * SPECIFICATION's origin, which is not where records live.
 */
import { type XmlElement, el, renderXmlDocument, text } from "../shared/xml.js";
import type { OpportunitySummary } from "./opportunity.mapper.js";

/** What a feed reader gets to see. Everything else in the record stays behind the API. */
export interface FeedEntry {
  /** Stable identifier — `atom:id` / RSS `guid`. See the module comment. */
  id: string;
  title: string;
  /** Where the entry points: the application URL when the record has one, else its own API URL. */
  link: string;
  /** Plain-text abstract (whitespace-collapsed description). */
  summary: string;
  updated: Date;
  published?: Date;
  /** Funding type first, then ecosystems. */
  categories: string[];
  /** The operating organization's display name. */
  author?: string;
}

export interface FeedIdentityOptions {
  /** `PUBLIC_BASE_URL` verbatim: an absolute origin with no trailing slash, or `/` when unset. */
  publicBaseUrl: string;
  /** Used only when a record carries no timestamp at all (the columns are NOT NULL, so: never). */
  now: Date;
}

export interface FeedDocumentOptions extends FeedIdentityOptions {
  /** Path of the feed being rendered, e.g. `/v1/feeds/opportunities.atom`. */
  selfPath: string;
}

/** The list endpoint — the feed's human/JSON counterpart, linked as its `alternate`. */
const COLLECTION_PATH = "/v1/opportunities";

export const FEED_TITLE = "RFP Hub — funding opportunities";
export const FEED_DESCRIPTION =
  "The most recently published Ethereum-ecosystem funding opportunities from the RFP Hub, newest first. Each entry is an RFP Hub Standard v1.0.0 record; the full object is one request away at its link.";
const GENERATOR = "RFP Hub API";

/** Is `PUBLIC_BASE_URL` an absolute origin, rather than the relative `/` default? */
function isAbsoluteBase(publicBaseUrl: string): boolean {
  return Boolean(publicBaseUrl) && publicBaseUrl !== "/";
}

/**
 * Percent-encode a public id for a URI path segment while keeping `:` — ids look like
 * `fundingmap:1459`, and a colon is a legal path character (RFC 3986 §3.3 `pchar`), so encoding it
 * would only make every link and identifier harder to read.
 */
function encodeId(publicId: string): string {
  return encodeURIComponent(publicId).replace(/%3A/gi, ":");
}

/** Absolute URL for `path` when a base is configured; the site-relative path otherwise. */
export function feedUrl(publicBaseUrl: string, path: string): string {
  return isAbsoluteBase(publicBaseUrl) ? `${publicBaseUrl}${path}` : path;
}

/** The record's own API URL (or path) — `GET /v1/opportunities/{id}`. */
export function recordUrl(publicBaseUrl: string, publicId: string): string {
  return feedUrl(publicBaseUrl, `${COLLECTION_PATH}/${encodeId(publicId)}`);
}

/** The record's stable feed identifier: its API URL, or the documented URN fallback. */
export function entryIdentifier(publicBaseUrl: string, publicId: string): string {
  return isAbsoluteBase(publicBaseUrl)
    ? recordUrl(publicBaseUrl, publicId)
    : `urn:rfphub:opportunity:${encodeId(publicId)}`;
}

/** The feed document's own identifier, same two forms as an entry's. */
function feedIdentifier(publicBaseUrl: string, selfPath: string): string {
  return isAbsoluteBase(publicBaseUrl)
    ? feedUrl(publicBaseUrl, selfPath)
    : `urn:rfphub:feed:${selfPath.split("/").pop()}`;
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Collapse every run of whitespace to a single space — feeds carry a one-line abstract. */
function plainText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One Standard opportunity → one feed entry.
 *
 * `link` prefers `applicationUrl`: a reader who clicks an entry wants the place to apply, and the
 * record's own API URL is still carried as its identifier. Records without one link back to
 * themselves. `summary` is the description as PLAIN TEXT — served with Atom's `type="text"`, so a
 * description containing markup is displayed literally rather than interpreted.
 */
export function toFeedEntry(opp: OpportunitySummary, opts: FeedIdentityOptions): FeedEntry {
  const updated = parseDate(opp.updatedAt) ?? parseDate(opp.createdAt) ?? opts.now;
  const categories = [...new Set([opp.fundingType as string, ...(opp.ecosystems ?? [])])].filter(
    (term) => term.trim().length > 0,
  );

  return {
    id: entryIdentifier(opts.publicBaseUrl, opp.id),
    title: plainText(opp.title),
    link: opp.applicationUrl ?? recordUrl(opts.publicBaseUrl, opp.id),
    summary: plainText(opp.description),
    updated,
    published: parseDate(opp.postedAt),
    categories,
    author: opp.operatingOrganizations[0]?.name,
  };
}

// ── date formats ──────────────────────────────────────────────────────────────────
/** RFC 3339 instant, as Atom requires. */
export function rfc3339(date: Date): string {
  return date.toISOString();
}

const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * RFC 822 date-time (in the RFC 1123 four-digit-year form), as RSS 2.0 requires. Always emitted in
 * GMT and always built from the UTC accessors, so the output never depends on the server's TZ.
 */
export function rfc822(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = RFC822_DAYS[date.getUTCDay()];
  const month = RFC822_MONTHS[date.getUTCMonth()];
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} GMT`;
}

/**
 * The document's own timestamp: the newest entry in it. Derived rather than "now", so the same
 * data always serializes to the same bytes — which is what makes the routes' content-derived
 * `ETag` stable across replicas and repeated polls. An EMPTY feed has nothing to derive from and
 * falls back to the caller's clock; both formats require the field.
 */
function documentUpdated(entries: FeedEntry[], now: Date): Date {
  let newest: Date | undefined;
  for (const entry of entries) {
    if (!newest || entry.updated > newest) newest = entry.updated;
  }
  return newest ?? now;
}

// ── Atom 1.0 (RFC 4287) ───────────────────────────────────────────────────────────
function atomEntry(entry: FeedEntry): XmlElement {
  return el("entry", undefined, [
    text("title", entry.title, { type: "text" }),
    text("id", entry.id),
    text("updated", rfc3339(entry.updated)),
    entry.published ? text("published", rfc3339(entry.published)) : undefined,
    el("link", { rel: "alternate", href: entry.link }),
    text("summary", entry.summary, { type: "text" }),
    ...entry.categories.map((term) => el("category", { term })),
    entry.author ? el("author", undefined, [text("name", entry.author)]) : undefined,
  ]);
}

/** A complete Atom 1.0 feed document. */
export function renderAtomFeed(entries: FeedEntry[], opts: FeedDocumentOptions): string {
  const self = feedUrl(opts.publicBaseUrl, opts.selfPath);
  return renderXmlDocument(
    el("feed", { xmlns: "http://www.w3.org/2005/Atom" }, [
      text("title", FEED_TITLE),
      text("subtitle", FEED_DESCRIPTION),
      text("id", feedIdentifier(opts.publicBaseUrl, opts.selfPath)),
      text("updated", rfc3339(documentUpdated(entries, opts.now))),
      el("link", { rel: "self", type: "application/atom+xml", href: self }),
      el("link", {
        rel: "alternate",
        type: "application/json",
        href: feedUrl(opts.publicBaseUrl, COLLECTION_PATH),
      }),
      text("generator", GENERATOR),
      ...entries.map(atomEntry),
    ]),
  );
}

// ── RSS 2.0 ───────────────────────────────────────────────────────────────────────
function rssItem(entry: FeedEntry): XmlElement {
  return el("item", undefined, [
    text("title", entry.title),
    text("link", entry.link),
    // The identifier is an id, not a page — `isPermaLink="false"` says so explicitly, which is
    // what stops a reader from treating it as a URL to fetch (RSS 2.0 defaults it to true).
    text("guid", entry.id, { isPermaLink: "false" }),
    text("description", entry.summary),
    text("pubDate", rfc822(entry.published ?? entry.updated)),
    ...entry.categories.map((term) => text("category", term)),
    // RSS 2.0's own <author> is defined as an EMAIL address; the Standard publishes organization
    // names, not mailboxes, so the name goes in Dublin Core's dc:creator — the conventional home
    // for exactly this case, and one every reader understands.
    entry.author ? text("dc:creator", entry.author) : undefined,
  ]);
}

/** A complete RSS 2.0 feed document. */
export function renderRssFeed(entries: FeedEntry[], opts: FeedDocumentOptions): string {
  return renderXmlDocument(
    el(
      "rss",
      {
        version: "2.0",
        "xmlns:atom": "http://www.w3.org/2005/Atom",
        "xmlns:dc": "http://purl.org/dc/elements/1.1/",
      },
      [
        el("channel", undefined, [
          text("title", FEED_TITLE),
          text("link", feedUrl(opts.publicBaseUrl, COLLECTION_PATH)),
          text("description", FEED_DESCRIPTION),
          text("lastBuildDate", rfc822(documentUpdated(entries, opts.now))),
          text("generator", GENERATOR),
          // RSS 2.0 has no self-reference of its own; the Atom namespace's link element is the
          // universal convention for one, and every reader and validator expects it here.
          el("atom:link", {
            rel: "self",
            type: "application/rss+xml",
            href: feedUrl(opts.publicBaseUrl, opts.selfPath),
          }),
          ...entries.map(rssItem),
        ]),
      ],
    ),
  );
}
