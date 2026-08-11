import type { FastifyReply, FastifyRequest } from "fastify";
import { type FeedFormat, FeedService } from "../../services/feeds/feed.service.js";
import { FEED_CACHE_CONTROL, entityTag, ifNoneMatchSatisfied } from "../../shared/http-cache.js";
import { type RawQuery, parseFeedQuery } from "./types.js";

/**
 * Serve one syndication format.
 *
 * The document is sent as a `Buffer`, which is what keeps it intact: a Buffer payload bypasses
 * Fastify's response serializer entirely, so the bytes hashed into the `ETag` are exactly the
 * bytes on the wire. Sending a string would hand XML to fast-json-stringify.
 *
 * Caching is the point of the `ETag` here — a feed is polled on a timer by every subscriber
 * forever, so a matching `If-None-Match` returns 304 with no body. The validator and the cache
 * policy go out on the 304 as well as the 200 (RFC 9110 §15.4.5), so a client that revalidates
 * repeatedly keeps a usable, refreshed cache entry instead of losing its tag on the first hit.
 */
async function serve(format: FeedFormat, req: FastifyRequest, res: FastifyReply) {
  const service = new FeedService();
  const feed = await service.render(format, parseFeedQuery(req.query as RawQuery));
  const etag = entityTag(feed.body);

  res.header("ETag", etag).header("Cache-Control", FEED_CACHE_CONTROL);
  if (ifNoneMatchSatisfied(req.headers["if-none-match"], etag)) {
    return res.code(304).send();
  }
  return res.type(feed.contentType).send(feed.body);
}

/** GET /v1/feeds/opportunities.atom — Atom 1.0 (RFC 4287). */
const atom = async (req: FastifyRequest, res: FastifyReply) => serve("atom", req, res);

/** GET /v1/feeds/opportunities.rss — RSS 2.0. */
const rss = async (req: FastifyRequest, res: FastifyReply) => serve("rss", req, res);

export const feedController = { atom, rss };
