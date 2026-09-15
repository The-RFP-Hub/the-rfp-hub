/**
 * Pure model for the share card PNG (`/opportunities/[id]/card.png`): the strings the image
 * renders, derived once so they can be unit-tested without touching `next/og`.
 *
 * EVERY LISTING STRING HERE IS PUBLISHER-SUPPLIED. `ImageResponse` renders it as text, the same
 * guarantee the rest of this package gives (see `components/UntrustedText.tsx`) — but a card is a
 * fixed-size image, not a scrolling page, so a publisher who wrote a 2,000-character title would
 * blow past the frame rather than just look untidy. Truncating here, once, is the guardrail.
 */
import { formatDate } from "./format";
import { nextFixedDeadline } from "./format";
import { cardAward } from "./landing";
import { fundingTypeLabel } from "./presentation";
import type { Opportunity } from "./types";

const TITLE_LIMIT = 120;
const ORG_LIMIT = 60;
const MAX_ECOSYSTEMS = 4;

/** `value`, cut to `limit` characters with a trailing ellipsis when it was longer. */
function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export interface ShareCardModel {
  eyebrow: string;
  title: string;
  ecosystems: string;
  award: string;
  deadline: string;
  url: string;
  /** The same address without its scheme, which is how it reads on a slide. */
  displayUrl: string;
  positioning: string;
}

const POSITIONING = "An open index. Not an application portal.";

/**
 * The card's content for one listing, at the given site origin.
 *
 * `origin` is trusted (it comes from `lib/site-origin.ts`, never from listing data), so the URL is
 * built with a plain template rather than routed through `UntrustedText`-style escaping — the id is
 * the one part of the path that is publisher-chosen, and it is percent-encoded like every other
 * link to a listing in this package.
 */
export function shareCardModel(entry: Opportunity, origin: string): ShareCardModel {
  const operator = entry.operatingOrganizations[0];
  const org = operator ? truncate(operator.name, ORG_LIMIT) : null;
  const eyebrow = [fundingTypeLabel(entry.fundingType), org].filter(Boolean).join(" · ");
  const ecosystems = (entry.ecosystems ?? []).slice(0, MAX_ECOSYSTEMS).join(" · ");
  const next = nextFixedDeadline(entry.deadlines);
  const deadline = next
    ? formatDate(next.date)
    : (entry.deadlines ?? []).some((d) => d?.deadlineType === "rolling")
      ? "Rolling"
      : "—";

  return {
    eyebrow,
    title: truncate(entry.title, TITLE_LIMIT),
    ecosystems,
    award: cardAward(entry) ?? "Award not stated",
    deadline,
    url: `${origin}/opportunities/${encodeURIComponent(entry.id)}`,
    displayUrl: `${origin.replace(/^https?:\/\//, "")}/opportunities/${encodeURIComponent(entry.id)}`,
    positioning: POSITIONING,
  };
}
