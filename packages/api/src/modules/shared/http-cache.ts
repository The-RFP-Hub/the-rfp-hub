/**
 * Validator + freshness helpers for the responses this API serves as BYTES rather than as a JSON
 * object — the syndication feeds and the full-dataset downloads.
 *
 * A feed is polled, not browsed: a reader fetches the same URL every few minutes forever. Without
 * a validator every one of those polls transfers the whole document again, so the feed routes send
 * a strong `ETag` and honour `If-None-Match`.
 *
 * The tag is CONTENT-DERIVED (a truncated SHA-256 of the exact bytes), which means it is identical
 * across replicas and across restarts for the same data — a per-process counter or a `Last-Modified`
 * taken from process start would not be, and behind more than one instance a client would see the
 * tag flap and re-download on every poll. That holds for an EMPTY feed too — the case a poller hits
 * hardest — because the document's own timestamp is its newest entry, or the documented
 * `EMPTY_FEED_UPDATED` constant when it has no entry, and never the request clock: nothing in the
 * bytes varies per request, so identical data hashes identically in every case rather than only
 * when the feed has something in it. Deliberately no `Last-Modified`: the only honest
 * timestamp available is the newest record in the feed, which is already the feed's own `updated`,
 * and RFC 9110 §8.8 prefers a strong validator anyway.
 */
import { createHash } from "node:crypto";

/**
 * Feed cache policy: short and revalidating. The dataset changes when an ingest runs, so a few
 * minutes of staleness is acceptable, and `must-revalidate` keeps a stale copy from being served
 * after that window — the revalidation is cheap precisely because of the `ETag` above.
 */
export const FEED_CACHE_CONTROL = "public, max-age=300, must-revalidate";

/**
 * Download cache policy: the same window as a feed, for a different reason.
 *
 * A full-dataset download is the most expensive response this API serves, so the value of a cache
 * hit is far higher — but the acceptable staleness is the same, because it is the same dataset
 * behind both and the same ingest that moves it. `must-revalidate` keeps a shared cache from
 * serving a stale dataset past the window, and the `ETag` makes that revalidation a 304 rather
 * than a second full transfer. Kept as its own constant so the two policies can diverge without
 * one of them changing by accident.
 */
export const DOWNLOAD_CACHE_CONTROL = "public, max-age=300, must-revalidate";

/**
 * A strong entity-tag over the exact bytes served.
 *
 * 27 base64url characters carry 162 bits of the SHA-256 (each character encodes 6) — far past any
 * collision concern for "did this document change", and short enough to keep the header small.
 */
export function entityTag(body: Buffer | string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

/**
 * The same tag, marked WEAK (RFC 9110 §8.8.1).
 *
 * For representations whose bytes are not a pure function of the data — the JSON download stamps
 * every response with `generatedAt` — so two 200s carrying the same tag really can differ byte for
 * byte. A strong tag would be a claim of byte-equality this API cannot honour, and a strong tag
 * taken from the BODY instead would change on every single request and never yield a 304. Weak is
 * the honest third option: same dataset, possibly different bytes, and `If-None-Match` still
 * matches (the comparison below is the weak one either way).
 */
export function weakTag(etag: string): string {
  return `W/${etag}`;
}

/**
 * Does an `If-None-Match` header match this representation's entity-tag? (RFC 9110 §13.1.2.)
 *
 * `*` matches any existing representation; otherwise the header is a comma-separated list of
 * entity-tags compared with the WEAK comparison function, so a `W/` prefix on either side is
 * ignored — which is what makes an intermediary that weakened the tag still get its 304.
 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => opaque(candidate) === opaque(etag));
}
