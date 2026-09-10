/**
 * Who built and who funded the hub. This is attribution the maintainers chose to publish, not the
 * project's voice about its data sources, and it is the one place a partner name appears in the
 * application. `scripts/check-neutral.mjs` waives the source-neutral rule for THIS FILE ONLY; the
 * rest of the frontend, including the footer that renders these, is held to the rule like any
 * other file. Keep it to names and links.
 */
export const BUILT_BY = { name: "Karma", href: "https://karmahq.xyz" } as const;
export const FUNDED_BY = {
  name: "Ethereum Foundation Ecosystem Support Program",
  href: "https://esp.ethereum.foundation",
} as const;
