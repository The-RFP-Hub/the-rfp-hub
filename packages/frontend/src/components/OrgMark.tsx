"use client";

import { useState } from "react";

/**
 * An organization's mark: its verified logo, proxied through `/logos/[slug]` (never the publisher's
 * raw `logoUrl` — see `src/lib/csp.ts` for why that host never becomes an `<img src>`), or its
 * initials when it has none or has not claimed its namespace.
 *
 * `verified` gates the network request entirely: an unverified organization has no logo on the API
 * to begin with, and this component never guesses at a URL for one — it renders initials and stops.
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
  const showImage = verified && !broken;
  const classes = ["org-mark", className].filter(Boolean).join(" ");

  return (
    <span className={classes} aria-hidden="true">
      {showImage ? (
        <img
          src={`/logos/${encodeURIComponent(slug)}`}
          alt=""
          width={40}
          height={40}
          onError={() => setBroken(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** The one- or two-letter mark shown while an organization has no image, or has not claimed one. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [first = "", second = ""] = words;
  if (first === "") return "?";
  if (second === "") return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}
