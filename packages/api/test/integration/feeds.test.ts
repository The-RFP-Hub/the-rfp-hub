/**
 * The syndication feeds over HTTP: what they serve, what they refuse, what they never leak, and
 * how they behave on a second poll.
 *
 * Gated on DATABASE_URL like the other integration suites. Seeds its own isolated fixtures
 * (ecosystem "FEEDTEST", ids "feedtest:*") — including one PENDING and one UNLISTED record, which
 * the public-read invariant must keep out of every response — and cleans them up. Every document
 * assertion runs against a strict parser (test/helpers/xml.ts), so a well-formedness or escaping
 * regression fails before the element assertions are even reached.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { entryIdentifier, recordUrl } from "../../src/modules/mappers/feed.mapper.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { FEED_CACHE_CONTROL, entityTag } from "../../src/modules/shared/http-cache.js";
import { type XmlNode, child, children, parseXml, textOf } from "../helpers/xml.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;

const TAG = "FEEDTEST";
const ATOM = "/v1/feeds/opportunities.atom";
const RSS = "/v1/feeds/opportunities.rss";

/**
 * A title that is hostile in every way that matters to a serializer: markup, both quote forms, a
 * bare ampersand, one that looks like an entity, and a CDATA terminator.
 */
const HOSTILE_TITLE = "R&D \"grants\" <script>alert('x')</script> ]]> &amp; 100%";

const fixture = (over: Partial<Opportunity> & Pick<Opportunity, "id">): Opportunity =>
  ({
    specVersion: "1.0.0",
    fundingType: "grant",
    title: `Feed fixture ${over.id}`,
    description: "  A feed fixture.\n\n  Multi-line, extra   spaced. ",
    status: "open",
    operatingOrganizations: [{ name: "Feed & Co", slug: "feedtest-org" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    fundingDetails: { fundingType: "grant" },
    ...over,
  }) as Opportunity;

run("GET /v1/feeds/opportunities.{atom,rss}", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const service = new OpportunityService();
    // Visible: three approved+listed records, one of them hostile, one with an applicationUrl.
    for (const record of [
      fixture({ id: "feedtest:plain" }),
      fixture({
        id: "feedtest:hostile",
        title: HOSTILE_TITLE,
        description: `Description with ${HOSTILE_TITLE}`,
        applicationUrl: "https://example.org/apply?a=1&b=2",
        postedAt: "2026-03-04T05:06:07.000Z",
      }),
      fixture({ id: "feedtest:closed", status: "closed" }),
    ]) {
      await service.upsertFromStandard(record, { reviewStatus: "approved", isListed: true });
    }
    // Invisible: the two halves of the public-read invariant.
    await service.upsertFromStandard(fixture({ id: "feedtest:pending" }), {
      reviewStatus: "pending",
      isListed: true,
    });
    await service.upsertFromStandard(fixture({ id: "feedtest:unlisted" }), {
      reviewStatus: "approved",
      isListed: false,
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "feedtest:%"));
    await db.delete(organizations).where(inArray(organizations.slug, ["feedtest-org"]));
    await app.close();
    await pool.end();
  });

  const get = (url: string, headers?: Record<string, string>) =>
    app.inject({ method: "GET", url, headers });

  /** Fetch a feed, assert the transport bits, and hand back the parsed document. */
  async function fetchFeed(url: string, mediaType: string): Promise<XmlNode> {
    const res = await get(url);
    expect(res.statusCode, url).toBe(200);
    expect(res.headers["content-type"], url).toBe(`${mediaType}; charset=utf-8`);
    return parseXml(res.rawPayload.toString("utf8"));
  }

  /** Atom entries / RSS items, whichever this document has. */
  function entriesOf(doc: XmlNode): XmlNode[] {
    if (doc.name === "feed") return children(doc, "entry");
    const channel = child(doc, "channel");
    if (!channel) throw new Error("RSS document has no <channel>");
    return children(channel, "item");
  }

  /** Every identifier in the document — Atom entry ids, RSS item guids. */
  function identifiersOf(doc: XmlNode): string[] {
    return entriesOf(doc).map((entry) => textOf(entry, doc.name === "feed" ? "id" : "guid") ?? "");
  }

  /**
   * The integration suites share one database and vitest runs their files in parallel, so the
   * dataset legitimately CAN change between two polls of a feed — every suite seeds and deletes
   * its own fixtures. The two assertions that compare responses to each other therefore retry
   * until they observe a settled pair, and fail loudly if the dataset never stops moving. This
   * weakens nothing: the tag being content-derived is asserted directly, against the bytes.
   */
  const ATTEMPTS = 10;

  /** Two consecutive polls that returned the same bytes. */
  async function settledPoll(url: string) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const first = await get(url);
      const second = await get(url);
      if (second.rawPayload.equals(first.rawPayload)) return { first, second };
    }
    throw new Error(`${url} never returned the same bytes twice in ${ATTEMPTS} attempts`);
  }

  /** A poll, then a revalidation of it whose `If-None-Match` was built from that poll's tag. */
  async function revalidate(url: string, header: (etag: string) => string) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const fresh = await get(url);
      const etag = String(fresh.headers.etag);
      const res = await get(url, { "if-none-match": header(etag) });
      if (res.statusCode === 304) return { etag, res };
    }
    throw new Error(`${url} never revalidated to a 304 in ${ATTEMPTS} attempts`);
  }

  const ourEntries = (doc: XmlNode) =>
    entriesOf(doc).filter((entry) => {
      const id = textOf(entry, doc.name === "feed" ? "id" : "guid") ?? "";
      return id.includes("feedtest:");
    });

  // ── Atom ────────────────────────────────────────────────────────────────────────
  it("serves a well-formed Atom 1.0 document with the required elements", async () => {
    const feed = await fetchFeed(`${ATOM}?limit=100`, "application/atom+xml");

    expect(feed.name).toBe("feed");
    expect(feed.attrs.xmlns).toBe("http://www.w3.org/2005/Atom");
    for (const required of ["id", "title", "updated"]) {
      expect(textOf(feed, required), `feed <${required}>`).toBeTruthy();
    }
    const self = children(feed, "link").find((link) => link.attrs.rel === "self");
    expect(self?.attrs.type).toBe("application/atom+xml");

    const ours = ourEntries(feed);
    expect(ours.length).toBe(3);
    for (const entry of ours) {
      for (const required of ["id", "title", "updated"]) {
        expect(textOf(entry, required), `entry <${required}>`).toBeTruthy();
      }
      expect(child(entry, "link")?.attrs.href, "entry link").toBeTruthy();
      expect(children(entry, "category").map((c) => c.attrs.term)).toContain(TAG);
      expect(textOf(child(entry, "author") as XmlNode, "name")).toBe("Feed & Co");
    }
  });

  // ── RSS ─────────────────────────────────────────────────────────────────────────
  it("serves a well-formed RSS 2.0 document with the required elements", async () => {
    const rss = await fetchFeed(`${RSS}?limit=100`, "application/rss+xml");

    expect(rss.name).toBe("rss");
    expect(rss.attrs.version).toBe("2.0");
    const channel = child(rss, "channel");
    if (!channel) throw new Error("no <channel>");
    for (const required of ["title", "link", "description"]) {
      expect(textOf(channel, required), `channel <${required}>`).toBeTruthy();
    }
    expect(child(channel, "atom:link")?.attrs.rel).toBe("self");

    // RSS 2.0 requires the data in URL-valued elements to begin with an IANA-registered URI scheme
    // (RSS Advisory Board specification), and the channel <link> is one of the required elements —
    // so this must hold in the deployment shape the suite actually runs under, whether or not
    // PUBLIC_BASE_URL is configured. Any registered scheme, not only http(s): unconfigured, the
    // documents fall back to `urn:` values rather than to site-relative paths.
    const REGISTERED_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
    expect(textOf(channel, "link"), "channel <link>").toMatch(REGISTERED_SCHEME);

    const ours = ourEntries(rss);
    expect(ours.length).toBe(3);
    for (const item of ours) {
      expect(textOf(item, "link"), "item <link>").toMatch(REGISTERED_SCHEME);
      expect(textOf(item, "guid"), "item <guid>").toBeTruthy();
      expect(child(item, "guid")?.attrs.isPermaLink).toBe("false");
      expect(textOf(item, "title"), "item <title>").toBeTruthy();
      expect(textOf(item, "pubDate")).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /);
      expect(textOf(item, "dc:creator")).toBe("Feed & Co");
    }
  });

  // ── escaping ────────────────────────────────────────────────────────────────────
  it("escapes a hostile title in both formats — markup never becomes markup", async () => {
    for (const [url, mediaType] of [
      [ATOM, "application/atom+xml"],
      [RSS, "application/rss+xml"],
    ] as const) {
      const res = await get(`${url}?limit=100`);
      const raw = res.rawPayload.toString("utf8");

      // the injected markup is not present as markup, and the ampersand is an entity
      expect(raw, url).not.toContain("<script>");
      expect(raw, url).toContain("&lt;script&gt;");
      expect(raw, url).toContain("R&amp;D");
      expect(raw, url).not.toContain("]]>");

      // …and it reads back as EXACTLY the stored title, which is the real assertion
      const doc = parseXml(raw);
      const titles = ourEntries(doc).map((entry) => textOf(entry, "title"));
      expect(titles, url).toContain(HOSTILE_TITLE);
    }
  });

  // ── the public-read invariant ────────────────────────────────────────────────────
  it("never publishes an unapproved or unlisted record", async () => {
    for (const url of [`${ATOM}?limit=100`, `${RSS}?limit=100`]) {
      const res = await get(url);
      const raw = res.rawPayload.toString("utf8");
      expect(raw, url).not.toContain("feedtest:pending");
      expect(raw, url).not.toContain("feedtest:unlisted");

      const ids = identifiersOf(parseXml(raw));
      expect(
        ids.some((id) => id.endsWith("feedtest:plain")),
        url,
      ).toBe(true);
      expect(
        ids.some((id) => id.includes("pending") || id.includes("unlisted")),
        url,
      ).toBe(false);
    }
  });

  // ── entry identity ──────────────────────────────────────────────────────────────
  it("identifies entries by a stable identifier derived from the record id", async () => {
    const feed = await fetchFeed(`${ATOM}?limit=100`, "application/atom+xml");
    const plain = ourEntries(feed).find((entry) => textOf(entry, "id")?.endsWith("feedtest:plain"));
    if (!plain) throw new Error("the plain fixture is missing from the feed");

    // Configured or not, the identifier and the self link are derived from the record id alone —
    // never from the request's Host header (see the mapper's module comment).
    expect(textOf(plain, "id")).toBe(entryIdentifier(config.publicBaseUrl, "feedtest:plain"));
    expect(child(plain, "link")?.attrs.href).toBe(
      recordUrl(config.publicBaseUrl, "feedtest:plain"),
    );

    // A record WITH an applicationUrl links there instead, keeping its own id as the identifier.
    const hostile = ourEntries(feed).find((entry) =>
      textOf(entry, "id")?.endsWith("feedtest:hostile"),
    );
    expect(child(hostile as XmlNode, "link")?.attrs.href).toBe("https://example.org/apply?a=1&b=2");
    expect(textOf(hostile as XmlNode, "id")).toBe(
      entryIdentifier(config.publicBaseUrl, "feedtest:hostile"),
    );
    expect(textOf(hostile as XmlNode, "published")).toBe("2026-03-04T05:06:07.000Z");

    // The two formats identify the same records identically. Scoped to THIS suite's fixtures for
    // the same reason `settledPoll` retries: the two documents are two separate requests against a
    // database the other integration suites are concurrently seeding and deleting, so comparing
    // the whole documents compares two different moments in the dataset. Our own records are the
    // ones the assertion is actually about, and they are stable for the life of the file.
    const rss = await fetchFeed(`${RSS}?limit=100`, "application/rss+xml");
    const ourIdentifiers = (doc: XmlNode) =>
      new Set(identifiersOf(doc).filter((id) => id.includes("feedtest:")));
    expect(ourIdentifiers(rss)).toEqual(ourIdentifiers(feed));
  });

  // ── query contract ──────────────────────────────────────────────────────────────
  it("honours ?limit= and ?status=, and bounds the document", async () => {
    for (const url of [ATOM, RSS]) {
      expect(entriesOf(await fetchFeed(`${url}?limit=1`, mediaTypeOf(url))).length, url).toBe(1);

      const open = await fetchFeed(`${url}?status=open&limit=100`, mediaTypeOf(url));
      const ids = identifiersOf(open);
      expect(
        ids.some((id) => id.endsWith("feedtest:plain")),
        url,
      ).toBe(true);
      expect(
        ids.some((id) => id.endsWith("feedtest:closed")),
        url,
      ).toBe(false);
    }
  });

  it("400s on anything the contract does not accept, instead of ignoring it", async () => {
    for (const url of [ATOM, RSS]) {
      for (const query of [
        "?nope=1", // unknown parameter
        "?stauts=open", // a typo is an unknown parameter
        "?status=nonsense", // out-of-Standard enum value
        "?limit=0", // below the bound
        "?limit=101", // above the bound
        "?limit=abc", // not an integer
        "?page=2", // a real parameter of the LIST endpoint, not of this one
        "?sort=postedAt",
      ]) {
        const res = await get(url + query);
        expect(res.statusCode, url + query).toBe(400);
        expect(res.json().error, url + query).toBe("bad_request");
      }
    }
  });

  // ── caching ─────────────────────────────────────────────────────────────────────
  it("sends a strong, content-derived ETag and honours If-None-Match", async () => {
    for (const url of [ATOM, RSS]) {
      const first = await get(url);
      const etag = String(first.headers.etag);
      expect(etag, url).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(first.headers["cache-control"], url).toBe(FEED_CACHE_CONTROL);
      // Content-derived, which is the property that makes it stable across replicas and restarts:
      // the tag is a function of the bytes sent, not of this process.
      expect(etag, url).toBe(entityTag(first.rawPayload));

      // Identical data → identical bytes → identical tag (nothing in the body is per-request).
      const settled = await settledPoll(url);
      expect(settled.second.headers.etag, url).toBe(settled.first.headers.etag);

      // a matching validator gets a 304 with no body, and keeps its validator + policy
      const revalidated = await revalidate(url, (tag) => tag);
      expect(revalidated.res.statusCode, url).toBe(304);
      expect(revalidated.res.rawPayload.length, url).toBe(0);
      expect(revalidated.res.headers.etag, url).toBe(revalidated.etag);
      expect(revalidated.res.headers["cache-control"], url).toBe(FEED_CACHE_CONTROL);

      // weak comparison (RFC 9110 §13.1.2): a W/ prefix and `*` both match; a stale tag does not
      expect((await revalidate(url, (tag) => `W/${tag}`)).res.statusCode, url).toBe(304);
      expect((await get(url, { "if-none-match": "*" })).statusCode, url).toBe(304);
      expect((await get(url, { "if-none-match": '"stale"' })).statusCode, url).toBe(200);

      // and a DIFFERENT representation has a different tag
      const narrower = await get(`${url}?limit=1`);
      expect(narrower.headers.etag, url).not.toBe(etag);
    }
  });

  // ── documentation ───────────────────────────────────────────────────────────────
  it("documents both operations in the served OpenAPI document", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the served OpenAPI document is dynamic JSON
    const doc: any = (await get("/v1/docs/json")).json();

    for (const [path, mediaType] of [
      [ATOM, "application/atom+xml"],
      [RSS, "application/rss+xml"],
    ] as const) {
      const operation = doc.paths?.[path]?.get;
      expect(operation, `documents GET ${path}`).toBeTruthy();
      expect(operation.operationId).toBeTruthy();
      expect(operation.tags).toContain("feeds");
      // the response is documented under the media type it is actually served as
      expect(Object.keys(operation.responses["200"].content)).toEqual([mediaType]);
      expect(operation.responses["200"].content[mediaType].schema.description).toBeTruthy();
      expect(operation.responses["400"], "the strict query contract is published").toBeTruthy();
      // both query parameters, with their bounds
      const params = new Map(
        (operation.parameters as { name: string; schema: Record<string, unknown> }[]).map((p) => [
          p.name,
          p,
        ]),
      );
      expect([...params.keys()].sort()).toEqual(["limit", "status"]);
      expect(params.get("limit")?.schema).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
    }

    // …and the feeds are discoverable from the service-info document
    const info = (await get("/")).json();
    expect(info.feeds).toEqual([
      { rel: "alternate", type: "application/atom+xml", href: ATOM },
      { rel: "alternate", type: "application/rss+xml", href: RSS },
    ]);
    expect(info.endpoints).toEqual(expect.arrayContaining([ATOM, RSS]));
  });
});

function mediaTypeOf(url: string): string {
  return url.endsWith(".atom") ? "application/atom+xml" : "application/rss+xml";
}
