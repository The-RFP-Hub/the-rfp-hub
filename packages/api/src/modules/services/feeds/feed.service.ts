/**
 * Feed assembly: read the most recent public opportunities, project them onto feed entries, render
 * the requested syndication format.
 *
 * The read goes through `OpportunityService.getAll`, deliberately and without a second query path:
 * that method is where the public-read invariant lives (`review_status = 'approved' AND
 * is_listed`), so a feed cannot drift into publishing a record the list endpoint hides. The feed
 * only fixes the parts of the query it owns — the sort, the page and the bounded size.
 */
import { config } from "../../../config.js";
import {
  type FeedEntry,
  renderAtomFeed,
  renderRssFeed,
  toFeedEntry,
} from "../../mappers/feed.mapper.js";
import type { OpportunityQuery } from "../opportunities/opportunity.service.js";
import { OpportunityService } from "../opportunities/opportunity.service.js";

export type FeedFormat = "atom" | "rss";

export interface RenderedFeed {
  /** The serialized document, as the exact bytes to send (and to hash into an `ETag`). */
  body: Buffer;
  /** Full `Content-Type`, charset included. */
  contentType: string;
  /** How many entries the document carries — logged/asserted, never guessed from the bytes. */
  entryCount: number;
}

const FORMATS = {
  atom: {
    path: "/v1/feeds/opportunities.atom",
    contentType: "application/atom+xml; charset=utf-8",
    render: renderAtomFeed,
  },
  rss: {
    path: "/v1/feeds/opportunities.rss",
    contentType: "application/rss+xml; charset=utf-8",
    render: renderRssFeed,
  },
} as const satisfies Record<
  FeedFormat,
  {
    path: string;
    contentType: string;
    render: (entries: FeedEntry[], opts: Parameters<typeof renderAtomFeed>[1]) => string;
  }
>;

/** The route path each format is served at — the routes and the docs read it from here. */
export const feedPath = (format: FeedFormat): string => FORMATS[format].path;

export class FeedService {
  constructor(private readonly opportunities: OpportunityService = new OpportunityService()) {}

  /**
   * Render one feed.
   *
   * Nothing in the document is taken from the clock: the document timestamp is the newest entry,
   * or the `EMPTY_FEED_UPDATED` constant when there is no entry, so the same data renders to the
   * same bytes every time — which is what the routes' content-derived `ETag` depends on, an empty
   * feed included. `now` is injectable and reaches only the ENTRY mapper, where it stands in for a
   * record carrying no timestamp at all (the columns are NOT NULL, so: never).
   */
  async render(
    format: FeedFormat,
    query: OpportunityQuery,
    now: Date = new Date(),
  ): Promise<RenderedFeed> {
    const { path, contentType, render } = FORMATS[format];
    const page = await this.opportunities.getAll(query);
    const { publicBaseUrl } = config;
    const entries = page.items.map((item) => toFeedEntry(item, { publicBaseUrl, now }));

    return {
      body: Buffer.from(render(entries, { publicBaseUrl, selfPath: path }), "utf8"),
      contentType,
      entryCount: entries.length,
    };
  }
}
