import { formatShortDate, hasRollingDeadline, nextFixedDeadline } from "./format";
/**
 * PURE aggregation for the front page: every open listing in, the numbers on the hero out.
 *
 * No React, no network. The page fetches the open set through the same `GET /v1/opportunities`
 * the directory reads, and everything shown above the fold is derived here so a unit test can pin
 * what "$143M in maximum awards listed" actually sums.
 */
import type { OpportunitySummary } from "./types";

export const CLOSING_SOON_DAYS = 30;
export const CLOSING_SOON_LIMIT = 6;
export const FEATURED_LIMIT = 3;
/** The hero's hand: one open listing of each, in this order. */
export const HAND_TYPES = ["grant", "hackathon", "bounty"] as const;

export interface LandingSummary {
  open: number;
  organizations: number;
  /** Sum of `maxAward`, USD entries only. Budgets are not awards and are left out. */
  awardsUsd: number;
  awardsCounted: number;
  closingSoon: OpportunitySummary[];
  closingSoonTotal: number;
  byType: Record<string, number>;
  featured: OpportunitySummary[];
  /** One listing per `HAND_TYPES` entry that has an open listing, in that order. See `dealHand`. */
  hand: OpportunitySummary[];
}

/**
 * One number per listing for ranking and summing: the stated award CEILING, in USD, and nothing
 * else. A program budget is not an award — Mantle's $100M fund would triple the figure on its own
 * — so it stays out of the tally and out of the "largest awards" ranking, and appears only on the
 * card of the listing that stated it.
 */
export function headlineAmountUsd(item: OpportunitySummary): number | null {
  const funding = item.fundingInfo;
  if (!funding || (funding.currency ?? "USD").toUpperCase() !== "USD") return null;
  const value = funding.maxAward ?? null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** "$143M", "$82k", "$500". Compact because it sits in a headline, not a ledger. */
export function compactUsd(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `$${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

/** A stated USD pool (`budget`), or null. Never a ceiling: see `headlineAmountUsd`. */
export function poolUsd(item: OpportunitySummary): number | null {
  const funding = item.fundingInfo;
  if (!funding || (funding.currency ?? "USD").toUpperCase() !== "USD") return null;
  const value = funding.budget ?? null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The award line on a card. Prefers the ceiling; a range is shown as one. */
export function cardAward(item: OpportunitySummary): string | null {
  const funding = item.fundingInfo;
  if (!funding) return null;
  const unit = (funding.currency ?? "").trim();
  const usd = unit === "" || unit.toUpperCase() === "USD";
  const money = (n: number) => (usd ? compactUsd(n) : `${compactUsd(n).slice(1)} ${unit}`);
  if (funding.minAward && funding.maxAward)
    return `${money(funding.minAward)} to ${money(funding.maxAward)}`;
  if (funding.maxAward) return `Up to ${money(funding.maxAward)}`;
  if (funding.budget) return `${money(funding.budget)} pool`;
  if (funding.minAward) return `From ${money(funding.minAward)}`;
  return null;
}

export function summarizeLanding(
  items: readonly OpportunitySummary[],
  now: Date = new Date(),
  verified: ReadonlySet<string> = new Set(),
): LandingSummary {
  const orgs = new Set<string>();
  const byType: Record<string, number> = {};
  let awardsUsd = 0;
  let awardsCounted = 0;

  for (const item of items) {
    for (const org of item.operatingOrganizations) orgs.add(org.slug);
    byType[item.fundingType] = (byType[item.fundingType] ?? 0) + 1;
    const amount = headlineAmountUsd(item);
    if (amount !== null) {
      awardsUsd += amount;
      awardsCounted += 1;
    }
  }

  const horizon = now.getTime() + CLOSING_SOON_DAYS * 86_400_000;
  const dated: { item: OpportunitySummary; at: number }[] = [];
  for (const item of items) {
    const next = nextFixedDeadline(item.deadlines, now);
    if (next?.date) dated.push({ item, at: Date.parse(next.date) });
  }
  dated.sort((a, b) => a.at - b.at);
  const closing = dated.filter((entry) => entry.at <= horizon);

  // Featured: the largest stated awards among listings not already on the closing strip.
  const onStrip = new Set(closing.slice(0, CLOSING_SOON_LIMIT).map((entry) => entry.item.id));
  const featured = items
    .filter((item) => !onStrip.has(item.id) && headlineAmountUsd(item) !== null)
    .sort((a, b) => (headlineAmountUsd(b) ?? 0) - (headlineAmountUsd(a) ?? 0))
    .slice(0, FEATURED_LIMIT);

  return {
    open: items.length,
    organizations: orgs.size,
    awardsUsd,
    awardsCounted,
    closingSoon: closing.slice(0, CLOSING_SOON_LIMIT).map((entry) => entry.item),
    closingSoonTotal: closing.length,
    byType,
    featured,
    hand: dealHand(items, verified),
  };
}

/**
 * The hero's three cards: for each type, the largest stated USD award ceiling; when no listing of
 * that type states one, the largest stated USD pool; else the first by title. A pool is a whole
 * program's budget, not what one award can reach, so it is never ranked against a ceiling. A type
 * with no open listing is skipped, never invented.
 *
 * VERIFIED ORGANIZATIONS COME FIRST, AND THOSE WITH A STATED VALUE FIRST AMONG THEM. `verified`
 * holds the slugs `GET /v1/publishers` lists, and a listing counts as verified when any of them
 * operates or sponsors it. Each type is dealt from the first non-empty tier: verified with a stated
 * USD ceiling or pool, then verified with neither, then every listing of the type. The rule above
 * ranks within the tier. An empty set (the read failed) leaves only the last tier.
 */
export function dealHand(
  items: readonly OpportunitySummary[],
  verified: ReadonlySet<string> = new Set(),
  types: readonly string[] = HAND_TYPES,
): OpportunitySummary[] {
  const byTitle = (a: OpportunitySummary, b: OpportunitySummary) => a.title.localeCompare(b.title);
  const largest =
    (amount: (item: OpportunitySummary) => number | null) =>
    (a: OpportunitySummary, b: OpportunitySummary) =>
      (amount(b) ?? 0) - (amount(a) ?? 0) || byTitle(a, b);
  const pick = (list: OpportunitySummary[]) =>
    [...list.filter((item) => headlineAmountUsd(item) !== null)].sort(
      largest(headlineAmountUsd),
    )[0] ??
    [...list.filter((item) => poolUsd(item) !== null)].sort(largest(poolUsd))[0] ??
    [...list].sort(byTitle)[0];
  const hasValue = (item: OpportunitySummary) =>
    headlineAmountUsd(item) !== null || poolUsd(item) !== null;
  const isVerified = (item: OpportunitySummary) =>
    [...item.operatingOrganizations, ...(item.sponsoringOrganizations ?? [])].some((org) =>
      verified.has(org.slug),
    );
  const out: OpportunitySummary[] = [];
  for (const type of types) {
    const ofType = items.filter((item) => item.fundingType === type);
    const backed = ofType.filter(isVerified);
    const tiers = [backed.filter(hasValue), backed.filter((item) => !hasValue(item)), ofType];
    const chosen = pick(tiers.find((tier) => tier.length > 0) ?? []);
    if (chosen) out.push(chosen);
  }
  return out;
}

/**
 * Where a card's figure sits between its smallest and largest size: 0 at $100 or below (and for any
 * amount not stated in USD), 1 at $10M and above, on a log scale so $16M visibly outweighs $85k.
 */
export function awardScale(item: OpportunitySummary): number {
  const value = headlineAmountUsd(item) ?? poolUsd(item);
  if (!value) return 0;
  return Math.min(1, Math.max(0, (Math.log10(value) - 2) / 5));
}

/** `cardAward`'s line split so the amount can be set large: "Up to" · "$16M", "$85k" · "pool". */
export function awardParts(award: string): { before?: string; figure: string; after?: string } {
  const lead = /^(Up to|From|.+ to) (.+)$/.exec(award);
  if (lead?.[1] && lead[2]) return { before: lead[1], figure: lead[2] };
  const pool = /^(.+) pool$/.exec(award);
  if (pool?.[1]) return { figure: pool[1], after: "pool" };
  return { figure: award };
}

/** A hero card's date line: "submission · Oct 30" for the next fixed date, "Rolling", or null. */
export function handDate(item: OpportunitySummary, now: Date = new Date()): string | null {
  const next = nextFixedDeadline(item.deadlines, now);
  if (next?.date) return `${next.label?.trim() || "date"} · ${formatShortDate(next.date, now)}`;
  return hasRollingDeadline(item.deadlines) ? "Rolling" : null;
}

/** "1 day", "8 days", "today". */
export function daysUntil(iso: string, now: Date = new Date()): string {
  const days = Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}
