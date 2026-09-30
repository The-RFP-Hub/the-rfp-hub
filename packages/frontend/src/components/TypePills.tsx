"use client";

import { DecorativeIcon, type HeroIcon } from "@/components/IconLabel";
import { formatCount } from "@/lib/format";
import { fundingTypeLabel, fundingTypePlural } from "@/lib/presentation";
import type { FundingType } from "@/lib/types";
import {
  BanknotesIcon,
  BuildingOffice2Icon,
  CodeBracketIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
  Squares2X2Icon,
  TrophyIcon,
} from "@heroicons/react/20/solid";

/** One quickly recognizable silhouette per opportunity type, backed by the written Type column. */
export const FUNDING_TYPE_ICONS: Readonly<Record<FundingType, HeroIcon>> = {
  rfp: DocumentTextIcon,
  grant: BanknotesIcon,
  hackathon: CodeBracketIcon,
  bounty: TrophyIcon,
  accelerator: RocketLaunchIcon,
  vc_fund: BuildingOffice2Icon,
};

/** The four types a first-time reader thinks in, then everything else behind the select. */
const PILL_TYPES: readonly FundingType[] = ["grant", "hackathon", "bounty", "rfp"];

/**
 * The type pills: one control, used by the directory's filter bar and by the landing under its
 * search. `selected` is the current funding type ("" for every type); `showAll` adds the "All"
 * pill, which only means something where the pills filter a list already on screen.
 */
export function TypePills({
  selected,
  counts,
  onPick,
  showAll = true,
}: {
  selected: string;
  counts: Record<string, number> | null;
  onPick: (fundingType: string) => void;
  showAll?: boolean;
}) {
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : null;
  const other = selected && !PILL_TYPES.includes(selected as FundingType);
  return (
    <fieldset className="type-pills">
      <legend className="visually-hidden">Funding type</legend>
      {showAll ? (
        <button type="button" aria-pressed={selected === ""} onClick={() => onPick("")}>
          <DecorativeIcon icon={Squares2X2Icon} className="type-pill-icon" />
          All{total !== null ? <span className="type-pill-count">{formatCount(total)}</span> : null}
        </button>
      ) : null}
      {PILL_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          aria-pressed={selected === type}
          onClick={() => onPick(type)}
        >
          <DecorativeIcon icon={FUNDING_TYPE_ICONS[type]} className="type-pill-icon" />
          {fundingTypePlural(type)}
          {counts ? (
            <span className="type-pill-count">{formatCount(counts[type] ?? 0)}</span>
          ) : null}
        </button>
      ))}
      {other ? (
        <button type="button" aria-pressed onClick={() => onPick(selected)}>
          {selected in FUNDING_TYPE_ICONS ? (
            <DecorativeIcon
              icon={FUNDING_TYPE_ICONS[selected as FundingType]}
              className="type-pill-icon"
            />
          ) : null}
          {fundingTypeLabel(selected)}
        </button>
      ) : null}
    </fieldset>
  );
}
