import { nextFixedDeadline } from "./format";
/**
 * PURE aggregation for the front page: every open listing in, the numbers on the hero out.
 *
 * No React, no network. The page fetches the open set through the same `GET /v1/opportunities`
 * the directory reads, and everything shown above the fold is derived here so a unit test can pin
 * what "$143M in maximum awards listed" actually sums.
 */
import type { FundingType, OpportunitySummary } from "./types";

export const CLOSING_SOON_DAYS = 30;
export const CLOSING_SOON_LIMIT = 6;
export const FEATURED_LIMIT = 3;

/** The four tiles. `accelerator` and `vc_fund` are counted under "other" and linked from the copy. */
export const TILE_TYPES: readonly FundingType[] = ["grant", "hackathon", "bounty", "rfp"];

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
  };
}

/** "1 day", "8 days", "today". */
export function daysUntil(iso: string, now: Date = new Date()): string {
  const days = Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}
