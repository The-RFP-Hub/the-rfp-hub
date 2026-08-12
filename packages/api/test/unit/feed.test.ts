/**
 * Feed rendering, escaping and query normalization — all pure, no DB.
 *
 * Every assertion about a document goes through `test/helpers/xml.ts`, an independent strict
 * parser: a feed that is not well-formed fails before any element assertion runs, and the values
 * compared are the DECODED ones, so "escaped correctly" means "reads back as the original string"
 * rather than "contains the substring I expected".
 */
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_FEED_UPDATED,
  type FeedEntry,
  entryIdentifier,
  recordUrl,
  renderAtomFeed,
  renderRssFeed,
  rfc822,
  toFeedEntry,
} from "../../src/modules/mappers/feed.mapper.js";
import type { OpportunitySummary } from "../../src/modules/mappers/opportunity.mapper.js";
import {
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  parseFeedQuery,
} from "../../src/modules/routes/feeds/types.js";
import { entityTag, ifNoneMatchSatisfied } from "../../src/modules/shared/http-cache.js";
import {
  el,
  escapeXmlAttribute,
  escapeXmlText,
  renderXmlDocument,
  stripIllegalXmlChars,
  text as textNode,
} from "../../src/modules/shared/xml.js";
import { child, children, parseXml, textOf } from "../helpers/xml.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const BASE = "https://api.example.org";

/**
 * A title that is hostile in every way a feed can be attacked or broken: markup, both quote forms,
 * an ampersand that is not an entity, one that LOOKS like an entity, a CDATA terminator, a C0
 * control character with no legal XML representation, and an unpaired surrogate.
 */
const HOSTILE_TITLE =
  "Grants & \"Bounties\" <script>alert('xss')</script> ]]> &amp; &notanentity; \u0007\uD800 100% <b>";

const summary = (over: Partial<OpportunitySummary> = {}): OpportunitySummary => ({
  specVersion: "1.0.0",
  id: "feedtest:1",
  fundingType: "grant",
  title: "Ecosystem grants round",
  description: "  Funding for  public goods.\n\nApply any time. ",
  status: "open",
  operatingOrganizations: [{ name: "Example Foundation", slug: "example-foundation" }],
  source: { ingestedVia: "import", verifiedAgainstSource: null },
  ecosystems: ["Optimism", "Base"],
  postedAt: "2026-07-01T00:00:00.000Z",
  createdAt: "2026-07-02T00:00:00.000Z",
  updatedAt: "2026-07-03T12:00:00.000Z",
  ...over,
});

const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
  id: `${BASE}/v1/opportunities/feedtest:1`,
  title: "Ecosystem grants round",
  link: `${BASE}/v1/opportunities/feedtest:1`,
  summary: "Funding for public goods.",
  updated: new Date("2026-07-03T12:00:00.000Z"),
  categories: ["grant", "Optimism"],
  author: "Example Foundation",
  ...over,
});

const atomXml = (entries: FeedEntry[], publicBaseUrl = BASE) =>
  renderAtomFeed(entries, { publicBaseUrl, selfPath: "/v1/feeds/opportunities.atom" });

const rssXml = (entries: FeedEntry[], publicBaseUrl = BASE) =>
  renderRssFeed(entries, { publicBaseUrl, selfPath: "/v1/feeds/opportunities.rss" });

const atomOf = (entries: FeedEntry[], publicBaseUrl = BASE) =>
  parseXml(atomXml(entries, publicBaseUrl));

const rssOf = (entries: FeedEntry[], publicBaseUrl = BASE) =>
  parseXml(rssXml(entries, publicBaseUrl));

describe("the XML writer escapes by construction", () => {
  it("escapes character data and both quote forms in attributes", () => {
    expect(escapeXmlText("a & b < c > d \"e\" 'f'")).toBe("a &amp; b &lt; c &gt; d \"e\" 'f'");
    expect(escapeXmlAttribute("a & b < c > \"d\" 'e'")).toBe(
      "a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;",
    );
  });

  it("escapes attribute whitespace an XML processor would otherwise normalize away", () => {
    expect(escapeXmlAttribute("a\tb\nc\rd")).toBe("a&#9;b&#10;c&#13;d");
  });

  it("DROPS the characters XML 1.0 cannot represent at all, rather than escaping them", () => {
    // C0 controls other than TAB/LF/CR have no numeric-reference form either, and an unpaired
    // surrogate cannot be encoded as UTF-8 — `&#1;` would be exactly as fatal as the raw byte.
    expect(stripIllegalXmlChars("a\u0000b\u0007c\uFFFEd\uD800e")).toBe("abcde");
    expect(stripIllegalXmlChars("keep\tthese\nplease\r")).toBe("keep\tthese\nplease\r");
    // …while a well-formed surrogate PAIR is one legal astral character and survives intact.
    expect(stripIllegalXmlChars("rocket \u{1F680}")).toBe("rocket \u{1F680}");
  });

  it("refuses mixed content and invalid names instead of emitting broken markup", () => {
    expect(() =>
      renderXmlDocument({ name: "a", text: "x", children: [textNode("b", "y")] }),
    ).toThrow(/mixed content/);
    expect(() => renderXmlDocument(el("not a name"))).toThrow(/invalid XML name/);
    expect(() => renderXmlDocument(el("a", { "bad name": "x" }))).toThrow(/invalid XML name/);
  });

  it("round-trips a hostile string through the parser, minus the characters XML cannot carry", () => {
    const doc = parseXml(renderXmlDocument(textNode("t", HOSTILE_TITLE, { v: HOSTILE_TITLE })));
    // Everything survives except the two characters XML cannot carry, which are dropped.
    const expected = HOSTILE_TITLE.replace("\u0007", "").replace("\uD800", "");
    expect(doc.text).toBe(expected);
    expect(doc.attrs.v).toBe(expected);
  });
});

describe("entry mapping", () => {
  it("maps the Standard fields a reader can show", () => {
    const mapped = toFeedEntry(summary(), { publicBaseUrl: BASE, now: NOW });
    expect(mapped).toEqual({
      id: `${BASE}/v1/opportunities/feedtest:1`,
      title: "Ecosystem grants round",
      // no applicationUrl on this record → it links to itself
      link: `${BASE}/v1/opportunities/feedtest:1`,
      // whitespace-collapsed, trimmed, plain text
      summary: "Funding for public goods. Apply any time.",
      updated: new Date("2026-07-03T12:00:00.000Z"),
      published: new Date("2026-07-01T00:00:00.000Z"),
      categories: ["grant", "Optimism", "Base"],
      author: "Example Foundation",
    });
  });

  it("prefers applicationUrl as the link, and keeps the record URL as the identifier", () => {
    const mapped = toFeedEntry(summary({ applicationUrl: "https://example.org/apply?a=1&b=2" }), {
      publicBaseUrl: BASE,
      now: NOW,
    });
    expect(mapped.link).toBe("https://example.org/apply?a=1&b=2");
    expect(mapped.id).toBe(`${BASE}/v1/opportunities/feedtest:1`);
  });

  it("omits `published` when the record has no postedAt, and falls back for `updated`", () => {
    const mapped = toFeedEntry(summary({ postedAt: undefined, updatedAt: undefined }), {
      publicBaseUrl: BASE,
      now: NOW,
    });
    expect(mapped.published).toBeUndefined();
    expect(mapped.updated).toEqual(new Date("2026-07-02T00:00:00.000Z")); // createdAt
  });

  it("derives identifiers from the record id under PUBLIC_BASE_URL, with a documented fallback", () => {
    expect(entryIdentifier(BASE, "fundingmap:1459")).toBe(
      `${BASE}/v1/opportunities/fundingmap:1459`,
    );
    expect(recordUrl(BASE, "fundingmap:1459")).toBe(`${BASE}/v1/opportunities/fundingmap:1459`);
    // Unconfigured (local development): a stable URN, and site-relative links.
    expect(entryIdentifier("/", "fundingmap:1459")).toBe("urn:rfphub:opportunity:fundingmap:1459");
    expect(recordUrl("/", "fundingmap:1459")).toBe("/v1/opportunities/fundingmap:1459");
    // A colon stays readable (a legal path character); anything genuinely unsafe is encoded.
    expect(recordUrl(BASE, "weird id/with space")).toBe(
      `${BASE}/v1/opportunities/weird%20id%2Fwith%20space`,
    );
  });
});

describe("Atom 1.0 (RFC 4287)", () => {
  it("carries the required feed-level and entry-level elements", () => {
    const feed = atomOf([entry(), entry({ id: `${BASE}/v1/opportunities/feedtest:2` })]);

    expect(feed.name).toBe("feed");
    expect(feed.attrs.xmlns).toBe("http://www.w3.org/2005/Atom");
    for (const required of ["id", "title", "updated"]) {
      expect(textOf(feed, required), `feed <${required}>`).toBeTruthy();
    }
    expect(textOf(feed, "id")).toBe(`${BASE}/v1/feeds/opportunities.atom`);

    const self = children(feed, "link").find((link) => link.attrs.rel === "self");
    expect(self?.attrs.type).toBe("application/atom+xml");
    expect(self?.attrs.href).toBe(`${BASE}/v1/feeds/opportunities.atom`);

    const entries = children(feed, "entry");
    expect(entries).toHaveLength(2);
    for (const item of entries) {
      for (const required of ["id", "title", "updated"]) {
        expect(textOf(item, required), `entry <${required}>`).toBeTruthy();
      }
      expect(child(item, "link")?.attrs.href).toBeTruthy();
    }
  });

  it("maps every entry field onto its Atom element", () => {
    const item = children(
      atomOf([entry({ published: new Date("2026-06-01T00:00:00.000Z") })]),
      "entry",
    )[0];
    if (!item) throw new Error("no entry rendered");

    expect(textOf(item, "title")).toBe("Ecosystem grants round");
    expect(child(item, "title")?.attrs.type).toBe("text");
    expect(textOf(item, "updated")).toBe("2026-07-03T12:00:00.000Z");
    expect(textOf(item, "published")).toBe("2026-06-01T00:00:00.000Z");
    expect(textOf(item, "summary")).toBe("Funding for public goods.");
    expect(child(item, "summary")?.attrs.type).toBe("text");
    expect(children(item, "category").map((c) => c.attrs.term)).toEqual(["grant", "Optimism"]);
    expect(textOf(child(item, "author") as never, "name")).toBe("Example Foundation");
  });

  it("omits `published` and `author` when the entry has neither", () => {
    const item = children(atomOf([entry({ published: undefined, author: undefined })]), "entry")[0];
    if (!item) throw new Error("no entry rendered");
    expect(child(item, "published")).toBeUndefined();
    expect(child(item, "author")).toBeUndefined();
  });

  it("timestamps the document from its newest entry, not from the clock", () => {
    const older = entry({ updated: new Date("2026-01-01T00:00:00.000Z") });
    const newer = entry({ updated: new Date("2026-05-05T05:05:05.000Z") });
    expect(textOf(atomOf([older, newer]), "updated")).toBe("2026-05-05T05:05:05.000Z");
    // …and an empty feed, which has nothing to derive from, uses the documented constant.
    expect(textOf(atomOf([]), "updated")).toBe(EMPTY_FEED_UPDATED.toISOString());
  });

  it("stays well-formed and faithful with a hostile title", () => {
    const item = children(
      atomOf([entry({ title: HOSTILE_TITLE, summary: HOSTILE_TITLE })]),
      "entry",
    )[0];
    if (!item) throw new Error("no entry rendered");
    const expected = HOSTILE_TITLE.replace("\u0007", "").replace("\uD800", "");
    expect(textOf(item, "title")).toBe(expected);
    expect(textOf(item, "summary")).toBe(expected);
  });
});

describe("RSS 2.0", () => {
  it("carries the required channel and item elements", () => {
    const rss = rssOf([entry()]);
    expect(rss.name).toBe("rss");
    expect(rss.attrs.version).toBe("2.0");

    const channel = child(rss, "channel");
    if (!channel) throw new Error("no channel rendered");
    for (const required of ["title", "link", "description"]) {
      expect(textOf(channel, required), `channel <${required}>`).toBeTruthy();
    }
    expect(textOf(channel, "link")).toBe(`${BASE}/v1/opportunities`);
    expect(child(channel, "atom:link")?.attrs.href).toBe(`${BASE}/v1/feeds/opportunities.rss`);
    expect(rss.attrs["xmlns:atom"]).toBe("http://www.w3.org/2005/Atom");

    const item = child(channel, "item");
    if (!item) throw new Error("no item rendered");
    expect(textOf(item, "guid")).toBe(`${BASE}/v1/opportunities/feedtest:1`);
    // an id, not a page: readers must not fetch it
    expect(child(item, "guid")?.attrs.isPermaLink).toBe("false");
    expect(textOf(item, "title")).toBe("Ecosystem grants round");
    expect(textOf(item, "link")).toBe(`${BASE}/v1/opportunities/feedtest:1`);
    expect(textOf(item, "description")).toBe("Funding for public goods.");
    expect(children(item, "category").map((c) => c.text)).toEqual(["grant", "Optimism"]);
    // organization names are not mailboxes, so the creator is Dublin Core's, not RSS's <author>
    expect(textOf(item, "dc:creator")).toBe("Example Foundation");
    expect(rss.attrs["xmlns:dc"]).toBe("http://purl.org/dc/elements/1.1/");
  });

  it("dates items in RFC 822, from postedAt when there is one", () => {
    const channel = child(
      rssOf([entry({ published: new Date("2026-06-01T09:08:07.000Z") })]),
      "channel",
    );
    expect(textOf(child(channel as never, "item") as never, "pubDate")).toBe(
      "Mon, 01 Jun 2026 09:08:07 GMT",
    );
    // …and from `updated` when there is not
    const undated = child(rssOf([entry({ published: undefined })]), "channel");
    expect(textOf(child(undated as never, "item") as never, "pubDate")).toBe(
      "Fri, 03 Jul 2026 12:00:00 GMT",
    );
  });

  it("formats RFC 822 dates in GMT, independent of the server's timezone", () => {
    expect(rfc822(new Date("2026-01-02T03:04:05.000Z"))).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
    expect(rfc822(new Date("2026-12-31T23:59:59.000Z"))).toBe("Thu, 31 Dec 2026 23:59:59 GMT");
  });

  it("stays well-formed and faithful with a hostile title", () => {
    const channel = child(rssOf([entry({ title: HOSTILE_TITLE })]), "channel");
    const item = child(channel as never, "item");
    expect(item && textOf(item, "title")).toBe(
      HOSTILE_TITLE.replace("\u0007", "").replace("\uD800", ""),
    );
  });

  /**
   * RSS 2.0 is stricter than Atom about URLs: the RSS Advisory Board specification requires the
   * data in URL-valued elements to begin with an IANA-registered URI scheme, and the channel
   * `<link>` is REQUIRED — so a site-relative path there is not a conformant document at all. The
   * assertion is the SCHEME rule, not `http(s)`, because RSS permits any registered scheme, which
   * is exactly what the unconfigured fallback relies on.
   */
  const REGISTERED_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

  it("begins every URL-valued element with a registered URI scheme, configured or not", () => {
    for (const base of [BASE, "/"]) {
      const mapped = [
        toFeedEntry(summary(), { publicBaseUrl: base, now: NOW }),
        toFeedEntry(summary({ id: "feedtest:2", applicationUrl: "https://example.org/apply" }), {
          publicBaseUrl: base,
          now: NOW,
        }),
      ];
      const channel = child(rssOf(mapped, base), "channel");
      if (!channel) throw new Error("no channel rendered");
      expect(textOf(channel, "link"), base).toMatch(REGISTERED_SCHEME);
      for (const item of children(channel, "item")) {
        expect(textOf(item, "link"), base).toMatch(REGISTERED_SCHEME);
      }
    }

    // Configured, those values are the API's own URLs — the self link included…
    const configured = child(rssOf([entry()], BASE), "channel");
    expect(textOf(configured as never, "link")).toBe(`${BASE}/v1/opportunities`);
    expect(child(configured as never, "atom:link")?.attrs.href).toMatch(REGISTERED_SCHEME);

    // …and unconfigured they fall back to the documented URNs rather than to relative paths.
    const local = child(
      rssOf([toFeedEntry(summary(), { publicBaseUrl: "/", now: NOW })], "/"),
      "channel",
    );
    expect(textOf(local as never, "link")).toBe("urn:rfphub:collection:opportunities");
    expect(textOf(child(local as never, "item") as never, "link")).toBe(
      "urn:rfphub:opportunity:feedtest:1",
    );
  });
});

describe("an empty feed", () => {
  /**
   * The whole point of a content-derived `ETag` is that identical data hashes identically, and an
   * empty feed — no matches for a `?status=` filter, a filtered slice, a fresh deployment — is the
   * case a poller hits hardest. These assertions carry NO retry loop on purpose: with the document
   * timestamp taken from a constant rather than from the clock, two renders agree the first time
   * or the property is broken. (The integration suite's retry loops exist for a shared,
   * concurrently-mutated database; they are also what kept this instability from surfacing.)
   */
  it("renders identical bytes and an identical ETag at two different clocks", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
      const first = { atom: atomXml([]), rss: rssXml([]) };
      vi.setSystemTime(new Date("2026-08-01T01:23:45.678Z"));
      const second = { atom: atomXml([]), rss: rssXml([]) };

      for (const format of ["atom", "rss"] as const) {
        expect(second[format], format).toBe(first[format]);
        expect(entityTag(second[format]), format).toBe(entityTag(first[format]));
        // …which is the property a conditional GET needs: the validator handed out by the first
        // poll still matches the second poll's document, so that poll is a 304, not a transfer.
        expect(
          ifNoneMatchSatisfied(entityTag(first[format]), entityTag(second[format])),
          format,
        ).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("dates itself from the documented constant, in both formats", () => {
    expect(EMPTY_FEED_UPDATED.getTime()).toBe(0);
    expect(textOf(atomOf([]), "updated")).toBe(EMPTY_FEED_UPDATED.toISOString());
    expect(textOf(child(rssOf([]), "channel") as never, "lastBuildDate")).toBe(
      rfc822(EMPTY_FEED_UPDATED),
    );
  });
});

describe("the feed query contract", () => {
  it("defaults to the newest 50, first page, newest-first by `createdAt`", () => {
    expect(parseFeedQuery({})).toMatchObject({
      limit: DEFAULT_FEED_LIMIT,
      page: 1,
      sort: "createdAt",
      order: "desc",
      status: undefined,
    });
  });

  it("takes `limit` and normalizes `status` the way the list endpoint does", () => {
    expect(parseFeedQuery({ limit: 7 }).limit).toBe(7);
    expect(parseFeedQuery({ status: "open,upcoming" }).status).toEqual(["open", "upcoming"]);
    expect(parseFeedQuery({ status: ["open", "open"] }).status).toEqual(["open"]);
    expect(parseFeedQuery({ status: "" }).status).toBeUndefined();
  });

  it("keeps the fixed parts fixed, whatever a direct caller passes", () => {
    const query = parseFeedQuery({ sort: "postedAt", order: "asc", page: 9, q: "anything" });
    expect(query).toMatchObject({ sort: "createdAt", order: "desc", page: 1 });
  });

  it("clamps out-of-range limits for direct callers (over HTTP the schema 400s first)", () => {
    expect(parseFeedQuery({ limit: 0 }).limit).toBe(1);
    expect(parseFeedQuery({ limit: 1000 }).limit).toBe(MAX_FEED_LIMIT);
    expect(parseFeedQuery({ limit: "not-a-number" }).limit).toBe(DEFAULT_FEED_LIMIT);
  });
});
