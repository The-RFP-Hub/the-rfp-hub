"use client";

import { OrgMark } from "@/components/OrgMark";
import { UntrustedText } from "@/components/UntrustedText";
import { formatDate, nextFixedDeadline } from "@/lib/format";
import { cardAward, daysUntil } from "@/lib/landing";
import { fundingTypeLabel } from "@/lib/presentation";
import type { OpportunitySummary } from "@/lib/types";
import Link from "next/link";

/**
 * One listing as a card: type, deadline, title, organization, award. The same five facts the
 * directory row carries, arranged so the eye reads type + award + deadline together.
 *
 * Shared between the landing page's strips and the directory's card view — one markup, one CSS
 * class, so a listing looks the same wherever it is a card.
 */
export function OpportunityCard({ item, large }: { item: OpportunitySummary; large?: boolean }) {
  const operator = item.operatingOrganizations[0];
  const next = nextFixedDeadline(item.deadlines);
  const award = cardAward(item);
  const soon = next ? Date.parse(next.date ?? "") - Date.now() < 7 * 86_400_000 : false;
  return (
    <Link
      className={`opportunity-card${large ? " is-large" : ""}`}
      href={`/opportunities/${encodeURIComponent(item.id)}`}
    >
      <span className="opportunity-card-top">
        <span className="type-chip" data-type={item.fundingType}>
          {fundingTypeLabel(item.fundingType)}
        </span>
        <span className={`opportunity-card-deadline${soon ? " is-soon" : ""}`}>
          {next?.date ? (
            <>
              {formatDate(next.date)}
              {soon ? ` · ${daysUntil(next.date)}` : ""}
            </>
          ) : (
            "rolling"
          )}
        </span>
      </span>
      <span className="opportunity-card-title">
        <UntrustedText value={item.title} />
      </span>
      <span className="opportunity-card-org muted">
        {operator ? (
          <OrgMark
            slug={operator.slug}
            name={operator.name}
            // Whether this operator is verified is not carried on `OpportunitySummary` — only the
            // initials mark can be shown here until that changes.
            verified={false}
            className="org-mark-small"
          />
        ) : null}
        <UntrustedText value={operator?.name} />
      </span>
      {large && item.summary?.trim() ? (
        <span className="opportunity-card-summary muted">
          <UntrustedText value={item.summary} />
        </span>
      ) : null}
      <span className="opportunity-card-award">
        {award ?? <span className="muted">no award stated</span>}
      </span>
    </Link>
  );
}
