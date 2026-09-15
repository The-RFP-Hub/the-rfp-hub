/**
 * THE OPEN SET, fetched once and shared.
 *
 * Three surfaces derive numbers from "every open listing": the landing tally, the directory's
 * per-type counts and the publishers grid. Each used to page through `GET /v1/opportunities` on
 * its own. The set is small (about a hundred rows, one or two pages at the route's cap of 100), so
 * one in-memory promise per client is enough to make the second and third reads free within a
 * session, and a failed read is forgotten so the next caller retries.
 */
import type { ApiClient } from "./api";
import type { OpportunitySummary } from "./types";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const cache = new WeakMap<ApiClient, Promise<OpportunitySummary[]>>();

export function loadOpenSet(api: ApiClient): Promise<OpportunitySummary[]> {
  const cached = cache.get(api);
  if (cached) return cached;
  const promise = (async () => {
    const items: OpportunitySummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await api.directory.list({ status: "open", page, limit: PAGE_SIZE });
      items.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return items;
  })();
  cache.set(api, promise);
  promise.catch(() => cache.delete(api));
  return promise;
}

/** Open listings per funding type, for the directory's type pills. */
export function countByType(items: readonly OpportunitySummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.fundingType] = (out[item.fundingType] ?? 0) + 1;
  return out;
}
