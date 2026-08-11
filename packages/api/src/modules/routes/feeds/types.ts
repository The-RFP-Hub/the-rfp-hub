/**
 * PURE query-string contract for the feed routes — no Fastify/DB deps, unit-tested.
 *
 * Same strictness as the list endpoint, for the same reason: `feedQuerySchema` is validated by
 * Fastify BEFORE the handler runs, `additionalProperties: false` is enforced rather than stripped
 * (buildApp disables ajv's `removeAdditional`), so an unknown or misspelled parameter is a 400 and
 * never a feed that quietly ignored it. A subscriber pasting `?stauts=open` into a reader must
 * find out immediately, not six months later.
 *
 * The surface is deliberately two parameters wide. A feed is a subscription URL: everything it
 * accepts becomes a URL somebody saves forever, so the filters, sorts and pagination of
 * `/v1/opportunities` stay where they are — the feed is the recent-and-public slice, and clients
 * that need the full query language have the JSON endpoint.
 */
import type { OpportunityQuery } from "../../services/opportunities/opportunity.service.js";
import { type RawQuery, listQuerySchema, parseOpportunityQuery } from "../opportunities/types.js";

export type { RawQuery };

/** Entries per document when `?limit=` is absent. */
export const DEFAULT_FEED_LIMIT = 50;
/** Hard ceiling, matching the list endpoint's — one poll must stay one bounded response. */
export const MAX_FEED_LIMIT = 100;

/**
 * `?limit=`, normalized: absent, blank or unusable → the feed default; otherwise clamped into
 * 1..MAX. Over HTTP an out-of-range or non-integer value has already been rejected with a 400 by
 * `feedQuerySchema`, so this is the defensive path for direct, non-HTTP callers only — the feed
 * default is used rather than the LIST endpoint's smaller one, because a feed asked for "however
 * many you give me" should get a feed's worth.
 */
function requestedLimit(value: unknown): number {
  const first = Array.isArray(value) ? value[0] : value;
  const asNumber = typeof first === "number" ? first : Number(String(first ?? "").trim());
  const blank = first === undefined || first === null || String(first).trim() === "";
  if (blank || !Number.isFinite(asNumber)) return DEFAULT_FEED_LIMIT;
  return Math.min(Math.max(Math.trunc(asNumber), 1), MAX_FEED_LIMIT);
}

/**
 * The feed query, normalized onto the list endpoint's own query type.
 *
 * Everything a feed does NOT expose is fixed here rather than defaulted: newest first by
 * `createdAt` (publication recency — a re-ingest of an unchanged record bumps `updatedAt`, so
 * sorting on that would reshuffle the whole feed on every seed run and re-notify every
 * subscriber), and the first page only.
 *
 * `status` goes through `parseOpportunityQuery`, the list endpoint's own normalizer — splitting,
 * trimming and de-duping the list — so the two endpoints cannot drift into disagreeing about what
 * `?status=open,upcoming` means.
 */
export function parseFeedQuery(raw: RawQuery): OpportunityQuery {
  const parsed = parseOpportunityQuery({ status: raw.status });
  return {
    ...parsed,
    sort: "createdAt",
    order: "desc",
    page: 1,
    limit: requestedLimit(raw.limit),
  };
}

/**
 * JSON Schema for the feed querystring — request validation plus the OpenAPI documentation.
 *
 * `status` REUSES the list endpoint's parameter object, whose accepted values are derived from the
 * Standard's own enum at module load (see routes/opportunities/types.ts). Re-typing the values
 * here would let the two endpoints drift into disagreeing about which statuses exist, and a client
 * would see that as a hard 400 on one URL and a 200 on the other.
 */
export const feedQuerySchema = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_FEED_LIMIT,
      default: DEFAULT_FEED_LIMIT,
      description: `Number of entries in the document, newest first. 1..${MAX_FEED_LIMIT}; anything outside that range is a 400.`,
    },
    status: {
      ...listQuerySchema.properties.status,
      description: `${listQuerySchema.properties.status.description} Most subscribers want ?status=open.`,
    },
  },
  // Enforced, not stripped — see the module comment.
  additionalProperties: false,
} as const;
