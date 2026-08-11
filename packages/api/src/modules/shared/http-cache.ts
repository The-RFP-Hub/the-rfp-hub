/**
 * Validator + freshness helpers for the responses this API serves as BYTES rather than as a JSON
 * object — today the syndication feeds.
 *
 * A feed is polled, not browsed: a reader fetches the same URL every few minutes forever. Without
 * a validator every one of those polls transfers the whole document again, so the feed routes send
 * a strong `ETag` and honour `If-None-Match`.
 *
 * The tag is CONTENT-DERIVED (a truncated SHA-256 of the exact bytes), which means it is identical
 * across replicas and across restarts for the same data — a per-process counter or a `Last-Modified`
 * taken from process start would not be, and behind more than one instance a client would see the
 * tag flap and re-download on every poll. Deliberately no `Last-Modified`: the only honest
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
 * A strong entity-tag over the exact bytes served.
 *
 * 27 base64url characters is the full 160 bits of a truncated SHA-256 — far past any collision
 * concern for "did this document change", and short enough to keep the header small.
 */
export function entityTag(body: Buffer | string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
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
