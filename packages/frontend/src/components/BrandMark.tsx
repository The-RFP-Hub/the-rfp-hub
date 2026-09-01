/**
 * The RFP Hub mark, in-document version.
 *
 * A register: rows of listed entries, one live. It reads as the thing this site IS — a public
 * index — rather than as a picture of something.
 *
 * IT IS INK, AND THE ACTIVE ROW IS OPACITY, NOT HUE. The wordmark beside it stays ink for the
 * reason `globals.css` gives — an olive mark would make the rationed accent the brand — and the
 * same discipline binds this glyph: the one live entry is distinguished by full opacity against
 * the others' half, so nothing here depends on colour. The olive tile lives only on the app icon
 * (`app/icon.svg`), where a saturated ground is what a home screen expects.
 *
 * `currentColor` throughout: it inherits the ink of whatever it sits in — the header brand, the
 * footer — so there is one artwork and no per-placement fill to keep in sync.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* Listed entries: marker + row. Half opacity keeps them present but quiet. */}
      <g opacity="0.5">
        <rect x="11" y="14" width="5" height="5" rx="1" />
        <rect x="20" y="14" width="33" height="5" rx="2.5" />
        <rect x="11" y="38" width="5" height="5" rx="1" />
        <rect x="20" y="38" width="38" height="5" rx="2.5" />
        <rect x="11" y="50" width="5" height="5" rx="1" />
        <rect x="20" y="50" width="22" height="5" rx="2.5" />
      </g>
      {/* The live entry. */}
      <rect x="11" y="26" width="5" height="5" rx="1" />
      <rect x="20" y="26" width="27" height="5" rx="2.5" />
    </svg>
  );
}
