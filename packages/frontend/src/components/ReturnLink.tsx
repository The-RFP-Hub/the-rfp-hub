"use client";

import { IconLabel } from "@/components/IconLabel";
/**
 * The labelled way back, rendered only when the origin asked for one and the ask is safe.
 *
 * IT NAMES THE DESTINATION. "← Back" is barely better than the browser's own button; "← Back to
 * Filecoin Foundation" tells a reader who has been three levels deep in two different queues which
 * one they are returning to, before they click.
 *
 * IT RENDERS NOTHING BY DEFAULT. A detail page opened from a shared link, a bookmark or the public
 * directory has no origin to return to, and inventing one — "back to your listings" for somebody
 * who has never seen their listings — would be worse than the absence. `parseReturnLink` collapses
 * absent, external, malformed and off-allowlist to the same `null`, so this component has exactly
 * two states.
 *
 * The label can be publisher-supplied (an organization's name), so it renders as a text node like
 * every other untrusted string here.
 */
import { UntrustedText } from "@/components/UntrustedText";
import { RETURN_LABEL_PARAM, RETURN_PARAM, parseReturnLink } from "@/lib/return-to";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

export function ReturnLink() {
  const params = useSearchParams();
  const link = parseReturnLink(params?.get(RETURN_PARAM), params?.get(RETURN_LABEL_PARAM));
  if (!link) return null;

  return (
    <p className="muted">
      <Link href={link.href}>
        <IconLabel icon={ArrowLeftIcon}>
          Back to <UntrustedText value={link.label} />
        </IconLabel>
      </Link>
    </p>
  );
}

/**
 * Whether this page was reached from somewhere that offered a way back.
 *
 * Exported for the public detail page, which already has its own back affordance: two competing
 * "back" controls is one more than any page needs, so it hides its own when this one is showing.
 */
export function useHasReturnLink(): boolean {
  const params = useSearchParams();
  return parseReturnLink(params?.get(RETURN_PARAM), params?.get(RETURN_LABEL_PARAM)) !== null;
}
