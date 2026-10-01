"use client";

import { useState } from "react";

/**
 * An organization's mark: its verified logo, proxied through `/logos/[slug]` (never the publisher's
 * raw `logoUrl` — see `src/lib/csp.ts` for why that host never becomes an `<img src>`), or NOTHING
 * when it has none or has not claimed its namespace. The name always sits beside the mark, so a
 * stand-in (initials) only repeated it as noise.
 *
 * `verified` gates the network request entirely: an unverified organization has no logo on the API
 * to begin with, and this component never guesses at a URL for one — it renders nothing and stops.
 */
export function OrgMark({
  slug,
  name,
  verified,
  className,
}: {
  slug: string;
  name: string;
  verified: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!verified || broken) return null;
  const classes = ["org-mark", className].filter(Boolean).join(" ");

  return (
    <span className={classes} aria-hidden="true">
      <img
        src={`/logos/${encodeURIComponent(slug)}`}
        alt=""
        width={40}
        height={40}
        onError={() => setBroken(true)}
      />
    </span>
  );
}
